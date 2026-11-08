const express = require("express");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const multer = require("multer");
const { createZstdDecompress } = require("node:zlib");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const {
    parseHeader,
    parsePlayerInfo,
    parseEvent
} = require("@laihoe/demoparser2");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FACEIT_API_KEY;
const API = "https://open.faceit.com/data/v4";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SYNC_SECRET = process.env.SYNC_SECRET;

const TRACKING_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
const SYNC_BATCH_SIZE = 20;

const MAX_DEMO_SIZE = 200 * 1024 * 1024;
const MAX_UNCOMPRESSED_SIZE = 500 * 1024 * 1024;

const DEMO_TEMP_DIR = path.join(os.tmpdir(), "demoscope-uploads");

const replaySessions = new Map();
const REPLAY_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_REPLAY_SESSIONS = 2;
const MAX_REPLAY_STORAGE_SIZE = MAX_UNCOMPRESSED_SIZE;

fs.mkdirSync(DEMO_TEMP_DIR, { recursive: true });

function getReplayStorageSize() {
    let total = 0;
    for (const session of replaySessions.values()) {
        total += session.size || 0;
    }
    return total;
}

function deleteReplaySession(sessionId) {
    const session = replaySessions.get(sessionId);
    if (!session) return;
    replaySessions.delete(sessionId);
    fs.promises.unlink(session.path).catch(() => {});
}

function cleanupExpiredReplaySessions() {
    const now = Date.now();
    for (const [sessionId, session] of replaySessions.entries()) {
        if (session.expiresAt <= now) deleteReplaySession(sessionId);
    }
}

const replayCleanupTimer = setInterval(cleanupExpiredReplaySessions, 60 * 1000);
replayCleanupTimer.unref?.();

app.use(express.static(path.join(__dirname)));

const demoUpload = multer({
    dest: DEMO_TEMP_DIR,
    limits: { fileSize: MAX_DEMO_SIZE, files: 1 },
    fileFilter: (req, file, callback) => {
        const name = String(file.originalname || "").toLowerCase();
        if (!name.endsWith(".dem") && !name.endsWith(".dem.zst")) {
            return callback(new Error("Разрешены только файлы .dem и .dem.zst"));
        }
        callback(null, true);
    }
});

// ================================
// FACEIT API
// ================================

async function faceit(endpoint) {
    if (!API_KEY) throw new Error("Не настроен FACEIT_API_KEY в Render.");

    const response = await fetch(`${API}${endpoint}`, {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: "application/json"
        }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.message || `Ошибка FACEIT API: ${response.status}`);
    }

    return data;
}

// ================================
// SUPABASE
// ================================

async function supabaseRequest(resource, options = {}) {
    if (!TRACKING_ENABLED) {
        throw new Error("Не настроены SUPABASE_URL или SUPABASE_SECRET_KEY.");
    }

    const headers = {
        apikey: SUPABASE_SECRET_KEY,
        Accept: "application/json"
    };

    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.prefer) headers.Prefer = options.prefer;

    const response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    const raw = await response.text();
    let data = null;

    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        data = raw;
    }

    if (!response.ok) {
        const message = data && typeof data === "object"
            ? (data.message || data.details || data.hint || data.error)
            : data;
        throw new Error(message || `Ошибка Supabase: ${response.status}`);
    }

    return data;
}

async function saveEloSnapshot(playerId, nickname, elo) {
    const numericElo = Number(elo);

    if (!playerId || !Number.isFinite(numericElo) || numericElo < 0) {
        return false;
    }

    await supabaseRequest("rpc/record_faceit_elo", {
        method: "POST",
        body: {
            p_player_id: String(playerId),
            p_nickname: String(nickname || playerId),
            p_elo: Math.round(numericElo)
        }
    });

    return true;
}

async function getEloSnapshots(playerId) {
    const params = new URLSearchParams({
        select: "elo,observed_at",
        player_id: `eq.${playerId}`,
        order: "observed_at.desc",
        limit: "300"
    });

    const rows = await supabaseRequest(`elo_snapshots?${params.toString()}`);

    return (Array.isArray(rows) ? rows : [])
        .map(row => ({
            date: Date.parse(row.observed_at),
            elo: Number(row.elo)
        }))
        .filter(point =>
            Number.isFinite(point.date) && Number.isFinite(point.elo)
        )
        .reverse();
}

// ================================
// ОБЩИЕ ФУНКЦИИ
// ================================

function cleanNickname(value) {
    let nickname = String(value || "").trim();

    try {
        if (nickname.startsWith("http")) {
            const url = new URL(nickname);
            const parts = url.pathname.split("/").filter(Boolean);
            nickname = parts[parts.length - 1] || "";
        }
    } catch {}

    return nickname.replace(/^@/, "").slice(0, 60);
}

function numberStat(stats, keys) {
    for (const key of keys) {
        const value = stats?.[key];

        if (value !== undefined && value !== null && value !== "") {
            const number = Number(
                String(value).replace("%", "").replace(",", ".")
            );

            if (Number.isFinite(number)) return number;
        }
    }

    return null;
}

function normalizeMatch(item) {
    const stats = item.stats || item;

    const rawDate =
        stats["Match Finished At"] ||
        stats["Match Started At"] ||
        item.finished_at ||
        item.started_at;

    let date = rawDate ? Number(rawDate) : null;
    if (date && date < 1e12) date *= 1000;

    return {
        matchId: stats["Match Id"] || item.match_id || null,
        date,
        map: stats.Map || stats.map || "Неизвестно",
        kills: numberStat(stats, ["Kills"]),
        deaths: numberStat(stats, ["Deaths"]),
        kd: numberStat(stats, ["K/D Ratio", "K/D"]),
        adr: numberStat(stats, ["ADR"]),
        result: String(stats.Result || "")
    };
}

async function getPlayer(nickname) {
    const player = await faceit(
        `/players?nickname=${encodeURIComponent(nickname)}&game=cs2`
    );

    if (!player.player_id) throw new Error("Профиль FACEIT не найден.");
    return player;
}

async function getPages(endpoint) {
    const requests = [];

    for (let offset = 0; offset < 300; offset += 100) {
        requests.push(faceit(`${endpoint}&offset=${offset}&limit=100`));
    }

    const results = await Promise.allSettled(requests);

    return results
        .filter(result => result.status === "fulfilled")
        .flatMap(result => result.value.items || []);
}

function safeSecretEquals(provided, expected) {
    const a = Buffer.from(String(provided || ""));
    const b = Buffer.from(String(expected || ""));

    return a.length > 0 &&
        a.length === b.length &&
        crypto.timingSafeEqual(a, b);
}

// ================================
// ZSTD DECOMPRESSION
// ================================

async function decompressZstdFile(inputPath, outputPath) {
    let totalOutput = 0;

    const sizeLimiter = new Transform({
        transform(chunk, encoding, callback) {
            totalOutput += chunk.length;

            if (totalOutput > MAX_UNCOMPRESSED_SIZE) {
                return callback(
                    new Error("Распакованное демо превышает лимит 500 МБ.")
                );
            }

            callback(null, chunk);
        }
    });

    await pipeline(
        fs.createReadStream(inputPath),
        createZstdDecompress(),
        sizeLimiter,
        fs.createWriteStream(outputPath)
    );

    if (totalOutput === 0) {
        throw new Error("После распаковки файл оказался пустым.");
    }

    return outputPath;
}

// ================================
// CS2 DEMO ANALYZER
// ================================

function asRows(value) {
    if (Array.isArray(value)) return value;

    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    return [];
}

function eventNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function getEventName(event, keys) {
    for (const key of keys) {
        const value = event?.[key];
        if (value !== undefined && value !== null && String(value).trim()) {
            return String(value).trim();
        }
    }
    return "";
}

function isHeadshot(event) {
    const value = event?.headshot;
    return value === true || value === 1 || value === "1" ||
        String(value).toLowerCase() === "true";
}

function safeParseEvent(filePath, eventName, extraPlayer = [], extraOther = []) {
    try {
        return asRows(parseEvent(filePath, eventName, extraPlayer, extraOther));
    } catch (error) {
        console.warn(`Не удалось прочитать событие ${eventName}:`, error.message);
        return [];
    }
}

// Формирует список интересных эпизодов по событиям всей демки.
function buildHighlights(deaths) {
    const highlights = [];
    const validKills = [];

    for (const event of deaths) {
        const tick = Number(event.tick);
        const round = Number(
            event.total_rounds_played ??
            event.round ??
            event.round_number
        );

        const attacker = getEventName(event, [
            "attacker_name",
            "attacker"
        ]);

        const victim = getEventName(event, [
            "user_name",
            "user"
        ]);

        if (!Number.isFinite(tick) || tick < 0) continue;
        if (!attacker || attacker.toLowerCase() === "world") continue;
        if (!victim || victim.toLowerCase() === "world") continue;
        if (attacker.toLowerCase() === victim.toLowerCase()) continue;

        validKills.push({
            tick,
            round: Number.isFinite(round) ? round : null,
            attacker,
            victim,
            headshot: isHeadshot(event),
            weapon: String(event.weapon || event.weapon_name || "")
        });
    }

    validKills.sort((a, b) => a.tick - b.tick);

    // Отдельные убийства и хэдшоты.
    for (const kill of validKills) {
        highlights.push({
            id: `kill-${kill.tick}-${highlights.length}`,
            type: kill.headshot ? "headshot" : "kill",
            title: kill.headshot ? "Убийство в голову" : "Убийство",
            description: `${kill.attacker} устранил игрока ${kill.victim}`,
            player: kill.attacker,
            victim: kill.victim,
            round: kill.round,
            tick: kill.tick,
            timeSeconds: kill.tick / 64,
            score: kill.headshot ? 3 : 1
        });
    }

    // Серии убийств одного игрока в пределах 10 секунд одного раунда.
    const byPlayer = new Map();

    for (const kill of validKills) {
        const key = `${kill.attacker.toLowerCase()}|${kill.round ?? "unknown"}`;

        if (!byPlayer.has(key)) byPlayer.set(key, []);
        byPlayer.get(key).push(kill);
    }

    for (const kills of byPlayer.values()) {
        let group = [];

        function saveGroup() {
            if (group.length < 2) return;

            const count = group.length;
            const first = group[0];
            const last = group[group.length - 1];

            if (count >= 2) {
                const label = count >= 5
                    ? "5K — пять убийств"
                    : count === 4
                        ? "4K — четыре убийства"
                        : count === 3
                            ? "3K — три убийства"
                            : "2K — два убийства";

                highlights.push({
                    id: `multi-${first.tick}-${last.tick}`,
                    type: "multikill",
                    title: label,
                    description: `${first.attacker}: ${count} убийства за одну серию`,
                    player: first.attacker,
                    round: first.round,
                    tick: first.tick,
                    endTick: last.tick,
                    timeSeconds: first.tick / 64,
                    score: 5 + count * 3
                });
            }
        }

        for (const kill of kills) {
            const previous = group[group.length - 1];

            const sameRound = !previous ||
                previous.round === kill.round;

            const closeInTime = !previous ||
                kill.tick - previous.tick <= 10 * 64;

            if (!sameRound || !closeInTime) {
                saveGroup();
                group = [];
            }

            group.push(kill);
        }

        saveGroup();
    }

    // Первое убийство каждого раунда.
    const firstKillsByRound = new Map();

    for (const kill of validKills) {
        const key = kill.round ?? `unknown-${kill.tick}`;

        if (!firstKillsByRound.has(key)) {
            firstKillsByRound.set(key, kill);
        }
    }

    for (const kill of firstKillsByRound.values()) {
        highlights.push({
            id: `first-${kill.tick}`,
            type: "firstkill",
            title: "Первое убийство раунда",
            description: `${kill.attacker} первым открыл счёт в раунде`,
            player: kill.attacker,
            victim: kill.victim,
            round: kill.round,
            tick: kill.tick,
            timeSeconds: kill.tick / 64,
            score: 4
        });
    }

    // Убираем повторяющиеся записи одного типа с одинаковым тиком.
    const unique = new Map();

    for (const item of highlights) {
        const key = `${item.type}|${item.tick}|${item.player || ""}`;
        const old = unique.get(key);

        if (!old || item.score > old.score) unique.set(key, item);
    }

    return Array.from(unique.values())
        .sort((a, b) => b.score - a.score || a.tick - b.tick)
        .slice(0, 100);
}

function analyzeDemoFile(filePath) {
    const header = parseHeader(filePath) || {};

    const rawPlayers = asRows(parsePlayerInfo(filePath));

    const deaths = safeParseEvent(
        filePath,
        "player_death",
        [],
        ["total_rounds_played"]
    );

    const hurts = safeParseEvent(
        filePath,
        "player_hurt",
        [],
        ["total_rounds_played"]
    );

    const playersByName = new Map();

    for (const player of rawPlayers) {
        const name = String(
            player.name || player.player_name || ""
        ).trim();

        if (!name) continue;

        playersByName.set(name, {
            name,
            steamid: player.steamid ? String(player.steamid) : null,
            teamNumber: player.team_number ?? player.team_num ?? null,
            kills: 0,
            deaths: 0,
            assists: 0,
            damage: 0,
            headshotKills: 0
        });
    }

    function getOrAdd(nameValue) {
        const name = String(nameValue || "").trim();

        if (!name || name.toLowerCase() === "world") return null;

        if (!playersByName.has(name)) {
            playersByName.set(name, {
                name,
                steamid: null,
                teamNumber: null,
                kills: 0,
                deaths: 0,
                assists: 0,
                damage: 0,
                headshotKills: 0
            });
        }

        return playersByName.get(name);
    }

    for (const event of deaths) {
        const victim = getOrAdd(event.user_name || event.user);
        const attacker = getOrAdd(event.attacker_name || event.attacker);
        const assister = getOrAdd(event.assister_name || event.assister);

        if (victim) victim.deaths++;

        if (attacker && victim && attacker.name !== victim.name) {
            attacker.kills++;
            if (isHeadshot(event)) attacker.headshotKills++;
        }

        if (
            assister &&
            victim &&
            assister.name !== victim.name &&
            assister.name !== attacker?.name
        ) {
            assister.assists++;
        }
    }

    for (const event of hurts) {
        const attacker = getOrAdd(event.attacker_name || event.attacker);
        if (!attacker) continue;

        attacker.damage += eventNumber(
            event.dmg_health ??
            event.damage ??
            event.health_damage
        );
    }

    const players = Array.from(playersByName.values())
        .map(player => {
            const kd = player.deaths > 0
                ? Number((player.kills / player.deaths).toFixed(2))
                : player.kills;

            const hsPercent = player.kills > 0
                ? Number((player.headshotKills / player.kills * 100).toFixed(1))
                : 0;

            return {
                ...player,
                kd,
                hsPercent,
                damage: Math.round(player.damage)
            };
        })
        .sort((a, b) =>
            b.kills - a.kills || b.damage - a.damage
        );

    const roundValues = [
        ...deaths.map(event => event.total_rounds_played),
        ...hurts.map(event => event.total_rounds_played)
    ].map(Number).filter(Number.isFinite);

    const highlights = buildHighlights(deaths);

    return {
        map: header.map_name || header.map || "Неизвестно",
        serverName: header.server_name || null,
        demoVersion: header.demo_version_name || null,

        roundsObserved: roundValues.length
            ? Math.max(...roundValues)
            : null,

        players,

        events: {
            kills: deaths.length,
            damageEvents: hurts.length
        },

        highlights,

        highlightSummary: {
            total: highlights.length,
            multikills: highlights.filter(item => item.type === "multikill").length,
            headshots: highlights.filter(item => item.type === "headshot").length,
            firstKills: highlights.filter(item => item.type === "firstkill").length
        },

        note: "Статистика и лучшие моменты рассчитаны по событиям загруженной демки. Таймкоды используют тик демки; точность времени зависит от частоты тиков и формата записи."
    };
}

// ================================
// HEALTH
// ================================

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        keyConfigured: Boolean(API_KEY),
        supabaseConfigured: TRACKING_ENABLED,
        scheduledSyncConfigured: Boolean(SYNC_SECRET),
        demoParserConfigured: true,
        zstdConfigured: true
    });
});

// ================================
// DEMO UPLOAD + REPLAY FILE
// ================================

app.post("/api/demo/upload", (req, res) => {
    demoUpload.single("demo")(req, res, async error => {
        if (error) {
            const status = error instanceof multer.MulterError
                ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
                : 400;

            return res.status(status).json({
                error: error.message || "Не удалось загрузить демо."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: "Выбери файл .dem или .dem.zst."
            });
        }

        const uploadedPath = req.file.path;
        const originalName = path.basename(req.file.originalname);
        const replayId = crypto.randomUUID();
        const replayPath = path.join(DEMO_TEMP_DIR, `${replayId}.dem`);

        let replaySaved = false;

        try {
            if (originalName.toLowerCase().endsWith(".dem.zst")) {
                await decompressZstdFile(uploadedPath, replayPath);
            } else {
                await fs.promises.copyFile(uploadedPath, replayPath);
            }

            // ВАЖНО: анализ выполняется на сервере сразу по всему файлу.
            // Запускать или просматривать 3D-повтор для этого не требуется.
            const result = analyzeDemoFile(replayPath);
            const replayStat = await fs.promises.stat(replayPath);

            if (replayStat.size > MAX_REPLAY_STORAGE_SIZE) {
                throw new Error(
                    "Распакованная демка слишком большая для временного просмотра."
                );
            }

            cleanupExpiredReplaySessions();

            while (
                replaySessions.size >= MAX_REPLAY_SESSIONS ||
                getReplayStorageSize() + replayStat.size > MAX_REPLAY_STORAGE_SIZE
            ) {
                const oldestSessionId = replaySessions.keys().next().value;
                if (!oldestSessionId) break;
                deleteReplaySession(oldestSessionId);
            }

            replaySessions.set(replayId, {
                path: replayPath,
                size: replayStat.size,
                expiresAt: Date.now() + REPLAY_SESSION_TTL_MS
            });

            replaySaved = true;

            return res.json({
                ok: true,
                fileName: originalName,
                replayId,
                replayUrl: `/api/demo/replay/${replayId}`,
                replayExpiresInSeconds: Math.floor(REPLAY_SESSION_TTL_MS / 1000),
                ...result
            });

        } catch (parseError) {
            console.error("Ошибка обработки демо:", parseError);

            return res.status(422).json({
                error: "Не удалось обработать демо. Проверь, что файл корректный и поддерживается анализатором.",
                details: process.env.NODE_ENV === "development"
                    ? parseError.message
                    : undefined
            });

        } finally {
            fs.promises.unlink(uploadedPath).catch(() => {});
            if (!replaySaved) fs.promises.unlink(replayPath).catch(() => {});
        }
    });
});

// Получение распакованной демки браузерным проигрывателем.
app.get("/api/demo/replay/:id", (req, res) => {
    cleanupExpiredReplaySessions();

    const sessionId = String(req.params.id || "");

    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return res.status(400).json({ error: "Неверный идентификатор демо." });
    }

    const session = replaySessions.get(sessionId);

    if (!session) {
        return res.status(404).json({
            error: "Файл демо больше недоступен. Загрузи демо ещё раз."
        });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'inline; filename="demoscope.dem"');
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    res.sendFile(session.path, sendError => {
        deleteReplaySession(sessionId);

        if (sendError) {
            console.error("Ошибка передачи демо:", sendError.message);

            if (!res.headersSent) {
                res.status(500).json({
                    error: "Не удалось передать файл демо в браузер."
                });
            }
        }
    });
});

// ================================
// FACEIT PLAYER
// ================================

app.get("/api/player/:nickname", async (req, res) => {
    try {
        const nickname = cleanNickname(req.params.nickname);
        const player = await getPlayer(nickname);

        let lifetime = null;

        try {
            lifetime = await faceit(`/players/${player.player_id}/stats/cs2`);
        } catch {
            try {
                lifetime = await faceit(`/players/${player.player_id}/stats/csgo`);
            } catch {}
        }

        const game = player.games?.cs2 || player.games?.csgo || {};

        if (TRACKING_ENABLED) {
            try {
                await saveEloSnapshot(
                    player.player_id,
                    player.nickname,
                    game.faceit_elo
                );
            } catch (error) {
                console.error("Не удалось сохранить Elo:", error.message);
            }
        }

        res.json({
            player: {
                id: player.player_id,
                nickname: player.nickname,
                avatar: player.avatar,
                country: player.country,
                elo: game.faceit_elo,
                level: game.skill_level
            },
            lifetime
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================================
// FACEIT ANALYTICS
// ================================

app.get("/api/player/:nickname/analytics", async (req, res) => {
    try {
        const nickname = cleanNickname(req.params.nickname);
        const player = await getPlayer(nickname);
        const id = player.player_id;

        const now = Math.floor(Date.now() / 1000);
        const yearAgo = now - 365 * 24 * 60 * 60;

        const history = await getPages(
            `/players/${id}/history?game=cs2&from=${yearAgo}&to=${now}`
        );

        let rawStats = [];

        try {
            rawStats = await getPages(`/players/${id}/games/cs2/stats?`);
        } catch {
            rawStats = await getPages(`/players/${id}/games/csgo/stats?`)
                .catch(() => []);
        }

        const stats = rawStats.map(normalizeMatch);

        const statsMap = new Map(
            stats.filter(item => item.matchId)
                .map(item => [String(item.matchId), item])
        );

        const matches = history.map(match => {
            const matchId = match.match_id;
            const personal = statsMap.get(String(matchId));
            const teams = match.teams || {};

            let myTeam = null;

            for (const [name, team] of Object.entries(teams)) {
                if ((team.players || []).some(person => person.player_id === id)) {
                    myTeam = name;
                }
            }

            const winner = match.results?.winner;
            let result = "unknown";

            if (winner && myTeam) result = winner === myTeam ? "win" : "loss";

            const players = Object.values(teams).flatMap(team => team.players || []);
            const me = players.find(person => person.player_id === id);

            let date = Number(match.finished_at || match.started_at || 0);
            if (date && date < 1e12) date *= 1000;

            return {
                id: matchId,
                date,
                result,
                map: personal?.map || match.voting?.map?.pick?.[0] || "—",
                elo: me?.faceit_elo ?? null,
                score: match.results?.score || {},
                stats: personal || null
            };
        }).sort((a, b) => a.date - b.date);

        const mapStats = {};

        for (const match of stats) {
            const map = match.map || "Неизвестно";

            if (!mapStats[map]) {
                mapStats[map] = {
                    map,
                    matches: 0,
                    wins: 0,
                    kd: [],
                    adr: []
                };
            }

            const item = mapStats[map];
            item.matches++;

            if (match.result === "1") item.wins++;
            if (match.kd !== null) item.kd.push(match.kd);
            if (match.adr !== null) item.adr.push(match.adr);
        }

        const maps = Object.values(mapStats).map(item => ({
            map: item.map,
            matches: item.matches,
            winRate: item.matches ? Math.round(item.wins / item.matches * 100) : 0,
            kd: item.kd.length
                ? item.kd.reduce((a, b) => a + b, 0) / item.kd.length
                : null,
            adr: item.adr.length
                ? item.adr.reduce((a, b) => a + b, 0) / item.adr.length
                : null
        }));

        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        const bestMatch = stats
            .filter(match => match.date && match.date >= weekAgo)
            .sort((a, b) => (b.kd || 0) - (a.kd || 0))[0] || null;

        const game = player.games?.cs2 || player.games?.csgo || {};
        let eloPoints = [];

        let eloTracking = {
            enabled: TRACKING_ENABLED,
            saved: false,
            points: 0
        };

        if (TRACKING_ENABLED && Number.isFinite(Number(game.faceit_elo))) {
            try {
                await saveEloSnapshot(id, player.nickname, game.faceit_elo);
                eloPoints = await getEloSnapshots(id);

                eloTracking = {
                    enabled: true,
                    saved: true,
                    points: eloPoints.length
                };

            } catch (error) {
                console.error("Ошибка истории Elo:", error.message);

                eloTracking = {
                    enabled: true,
                    saved: false,
                    points: 0,
                    error: error.message
                };
            }
        }

        res.json({
            player: {
                id,
                nickname: player.nickname,
                avatar: player.avatar,
                country: player.country,
                elo: game.faceit_elo,
                level: game.skill_level
            },
            matches,
            matchStats: stats,
            maps,
            bestMatch,
            eloPoints,
            eloTracking,
            diagnostics: {
                historyCount: history.length,
                statsCount: stats.length
            }
        });

    } catch (error) {
        res.status(500).json({
            error: error.message || "Ошибка загрузки аналитики."
        });
    }
});

// ================================
// AUTOMATIC ELO SYNC
// ================================

app.post("/api/cron/sync", async (req, res) => {
    if (!SYNC_SECRET) {
        return res.status(503).json({
            error: "Не настроен SYNC_SECRET в Render."
        });
    }

    if (!safeSecretEquals(req.get("x-sync-secret"), SYNC_SECRET)) {
        return res.status(401).json({
            error: "Недействительный секрет синхронизации."
        });
    }

    if (!TRACKING_ENABLED) {
        return res.status(503).json({
            error: "Supabase не настроен."
        });
    }

    try {
        const players = await supabaseRequest(
            "tracked_players?select=player_id,nickname&order=last_checked_at.asc&limit=" +
            SYNC_BATCH_SIZE
        );

        let checked = 0;
        let failed = 0;

        for (const tracked of Array.isArray(players) ? players : []) {
            try {
                const player = await faceit(
                    `/players/${encodeURIComponent(tracked.player_id)}`
                );

                const game = player.games?.cs2 || player.games?.csgo || {};
                const elo = Number(game.faceit_elo);

                if (Number.isFinite(elo) && elo >= 0) {
                    await saveEloSnapshot(
                        tracked.player_id,
                        player.nickname || tracked.nickname,
                        elo
                    );
                    checked++;
                }

            } catch (error) {
                failed++;
                console.error(
                    `Ошибка синхронизации ${tracked.nickname}:`,
                    error.message
                );
            }
        }

        res.json({
            ok: true,
            selected: Array.isArray(players) ? players.length : 0,
            checked,
            failed,
            note: "Сохранены только новые значения Elo."
        });

    } catch (error) {
        console.error("Ошибка пакетной синхронизации:", error.message);

        res.status(500).json({
            error: error.message || "Ошибка синхронизации."
        });
    }
});

// ================================
// MAIN PAGE
// ================================

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ================================
// START SERVER
// ================================

app.listen(PORT, () => {
    console.log(`DemoScope запущен на порту ${PORT}`);
    console.log(`Supabase: ${TRACKING_ENABLED ? "подключен" : "не настроен"}`);
    console.log("Анализ демок CS2: подключен");
    console.log("Автоматический поиск лучших моментов: подключен");
    console.log("Распаковка Zstandard: подключена");
    console.log("Временное хранение демок: подключено");
});
