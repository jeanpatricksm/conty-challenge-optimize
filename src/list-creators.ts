import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string };
type MatchRow = CreatorMatch & { total: number };

// niche_score conta cada par de nichos iguais, como o laço original fazia.
const SCORED_CTE = `
scored AS (
  SELECT cr.id, cr.name, COUNT(*) AS niche_score
  FROM campaigns ca
  JOIN json_each(ca.niches_json) cn
  JOIN creators cr
  JOIN json_each(cr.niches_json) crn ON crn.value = cn.value
  WHERE ca.id = ?
  GROUP BY cr.id
)`;

const MATCHES_SQL = `
WITH ${SCORED_CTE},
latest AS (
  SELECT m.account_id, m.views,
    ROW_NUMBER() OVER (PARTITION BY m.account_id ORDER BY m.captured_at DESC, m.id DESC) AS rn
  FROM metrics m
  JOIN social_accounts sa ON sa.id = m.account_id
  JOIN scored s ON s.id = sa.creator_id
),
reach AS (
  SELECT sa.creator_id, SUM(l.views) AS latest_reach
  FROM latest l
  JOIN social_accounts sa ON sa.id = l.account_id
  WHERE l.rn = 1
  GROUP BY sa.creator_id
),
recent AS (
  SELECT d.creator_id, COUNT(*) AS deliveries_90d
  FROM deliveries d
  JOIN scored s ON s.id = d.creator_id
  WHERE d.delivered_at >= ?
  GROUP BY d.creator_id
)
SELECT s.id, s.name, s.niche_score,
  COALESCE(r.latest_reach, 0) AS latest_reach,
  COALESCE(d.deliveries_90d, 0) AS deliveries_90d,
  COUNT(*) OVER () AS total
FROM scored s
LEFT JOIN reach r ON r.creator_id = s.id
LEFT JOIN recent d ON d.creator_id = s.id
ORDER BY s.niche_score DESC, latest_reach DESC, s.id ASC
LIMIT ? OFFSET ?`;

const COUNT_SQL = `WITH ${SCORED_CTE} SELECT COUNT(*) AS n FROM scored`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT id FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const rows = await all<MatchRow>(db, MATCHES_SQL, input.campaignId, deliveriesSince(), input.limit, input.offset);
  const total = rows[0]?.total ?? (await get<{ n: number }>(db, COUNT_SQL, input.campaignId))?.n ?? 0;
  return {
    campaign_id: input.campaignId,
    total: Number(total),
    creators: rows.map(({ total: _total, ...creator }) => ({
      ...creator,
      latest_reach: Number(creator.latest_reach),
      deliveries_90d: Number(creator.deliveries_90d),
    })),
  };
}
