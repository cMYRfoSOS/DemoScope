const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FACEIT_API_KEY;
const API = "https://open.faceit.com/data/v4";

app.use(express.static(path.join(__dirname)));

async function faceit(endpoint) {
    if (!API_KEY) {
        throw new Error("Не настроен FACEIT_API_KEY в Render.");
    }

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
            const number = Number(String(value).replace("%", "").replace(",", "."));

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

    if (!player.player_id) {
        throw new Error("Профиль FACEIT не найден.");
    }

    return player;
}

async function getPages(endpoint) {
    const requests = [];

    for (let offset = 0; offset < 300; offset += 100) {
        requests.push(
            faceit(`${endpoint}&offset=${offset}&limit=100`)
        );
    }

    const results = await Promise.allSettled(requests);

    return results
        .filter(result => result.status === "fulfilled")
        .flatMap(result => result.value.items || []);
}

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        keyConfigured: Boolean(API_KEY)
    });
});

app.get("/api/player/:nickname", async (req, res) => {
    try {
        const nickname = cleanNickname(req.params.nickname);
        const player = await getPlayer(nickname);

        let lifetime = null;

        try {
            lifetime = await faceit(
                `/players/${player.player_id}/stats/cs2`
            );
        } catch {
            try {
                lifetime = await faceit(
                    `/players/${player.player_id}/stats/csgo`
                );
            } catch {}
        }

        const game = player.games?.cs2 || player.games?.csgo || {};

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
            rawStats = await getPages(
                `/players/${id}/games/cs2/stats?`
            );
        } catch {
            rawStats = await getPages(
                `/players/${id}/games/csgo/stats?`
            ).catch(() => []);
        }

        const stats = rawStats.map(normalizeMatch);

        const statsMap = new Map(
            stats.filter(s => s.matchId).map(s => [String(s.matchId), s])
        );

        const matches = history.map(match => {
            const matchId = match.match_id;
            const personal = statsMap.get(String(matchId));

            const teams = match.teams || {};
            let myTeam = null;

            for (const [name, team] of Object.entries(teams)) {
                if ((team.players || []).some(p => p.player_id === id)) {
                    myTeam = name;
                }
            }

            const winner = match.results?.winner;

            let result = "unknown";

            if (winner && myTeam) {
                result = winner === myTeam ? "win" : "loss";
            }

            const players = Object.values(teams).flatMap(
                team => team.players || []
            );

            const me = players.find(p => p.player_id === id);

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
            winRate: item.matches
                ? Math.round(item.wins / item.matches * 100)
                : 0,
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

        const eloPoints = matches
            .filter(match => match.elo !== null)
            .map(match => ({
                date: match.date,
                elo: Number(match.elo)
            }));

        const game = player.games?.cs2 || player.games?.csgo || {};

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

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
    console.log(`DemoScope запущен на порту ${PORT}`);
});
