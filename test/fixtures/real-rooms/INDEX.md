# Real-room fixture index

Captured live shard terrain (`npm run capture:rooms`); stats computed by
`npm run fixtures:index` with the bot's own placement/distance code
(src/spatial/spawnPlacement). Walk distances are BFS from the auto spawn
spot; ∞ = wall-locked (tunnel candidate). SK rooms have no controller and
are staging targets, not homes.

| fixture | wall% | swamp% | src | ctrl | lairs | spawn | src walks | ctrl walk | classes |
|---|---|---|---|---|---|---|---|---|---|
| shard3-W11N5 | 21 | 7 | 1 | y | 0 | 40,33 | 5 | 3 | open |
| shard3-W12N42 | 26 | 4 | 2 | y | 0 | 26,22 | 18/22 | 11 | plain |
| shard3-W13N8 | 17 | 19 | 2 | y | 0 | 38,18 | 9/10 | 9 | swampy open |
| shard3-W17N2 | 43 | 2 | 1 | y | 0 | 11,35 | 5 | 5 | plain |
| shard3-W1N4 | 31 | 7 | 2 | y | 0 | 20,25 | 1/15 | 16 | open |
| shard3-W1N5 | 33 | 20 | 1 | y | 0 | 30,18 | 40 | 13 | maze swampy |
| shard3-W1N6 | 55 | 4 | 2 | y | 0 | 28,30 | 25/38 | 20 | maze |
| shard3-W21N9 | 55 | 7 | 2 | y | 0 | 19,12 | 10/60 | 10 | maze |
| shard3-W23N3 | 58 | 1 | 2 | y | 0 | 23,21 | 16/35 | 10 | maze |
| shard3-W29N7 | 59 | 1 | 1 | y | 0 | 26,14 | 16 | 16 | maze |
| shard3-W2N4 | 23 | 1 | 1 | y | 0 | 26,35 | 15 | 15 | open |
| shard3-W2N5 | 33 | 2 | 1 | y | 0 | 10,28 | 11 | 10 | open |
| shard3-W2N6 | 34 | 1 | 2 | y | 0 | 25,27 | 22/23 | 16 | plain |
| shard3-W33N11 | 34 | 4 | 1 | y | 0 | 26,13 | 5 | 15 | open |
| shard3-W37N29 | 25 | 12 | 2 | y | 0 | 28,17 | 9/16 | 10 | swampy |
| shard3-W3N4 | 74 | 1 | 2 | y | 0 | 21,13 | 8/15 | 44 | maze |
| shard3-W3N5 | 33 | 24 | 2 | y | 0 | 30,29 | 20/24 | 11 | swampy |
| shard3-W3N6 | 15 | 3 | 1 | y | 0 | 28,24 | 15 | 15 | open |
| shard3-W41N6 | 34 | 35 | 1 | y | 0 | 24,11 | 16 | 16 | swampy |
| shard3-W44N21 | 40 | 10 | 2 | y | 0 | 33,32 | 58/59 | 36 | maze swampy |
| shard3-W4N4 | 30 | 7 | 3 | - | 4 | 28,29 | 22/12/16 | ∞ | sk |
| shard3-W4N7 | 44 | 13 | 2 | y | 0 | 19,23 | 1/9 | 8 | swampy |
| shard3-W6N12 | 31 | 18 | 2 | y | 0 | 38,30 | 11/26 | 4 | maze swampy |
| shard3-W7N3 | 31 | 11 | 2 | y | 0 | 5,23 | 5/17 | 26 | swampy |
| shard3-W8N2 | 27 | 39 | 1 | y | 0 | 33,33 | 9 | 9 | swampy open |
