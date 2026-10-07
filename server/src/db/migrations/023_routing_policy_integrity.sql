-- F-007: routing policy integrity.
-- One active policy per organization, one active global policy, and unique
-- versions per scope. Existing data is repaired first so the indexes can be
-- created safely: where several rows are active in one scope the newest stays
-- active and older ones are deactivated; rows that repeat a version within a
-- scope are renumbered above the scope's current maximum (oldest keeps its number).

-- 1. Keep only the newest active row per scope (org_id; NULL = global).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY created_at DESC, version DESC, id DESC
         ) AS rn
  FROM routing_policies
  WHERE is_active = TRUE
)
UPDATE routing_policies p
SET is_active = FALSE, updated_at = NOW()
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;

-- 2. Renumber duplicate versions within a scope.
WITH scoped AS (
  SELECT id,
         COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid) AS scope,
         version,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), version
           ORDER BY created_at ASC, id ASC
         ) AS dup_rn
  FROM routing_policies
),
maxv AS (
  SELECT scope, MAX(version) AS max_version FROM scoped GROUP BY scope
),
dups AS (
  SELECT s.id, m.max_version,
         ROW_NUMBER() OVER (PARTITION BY s.scope ORDER BY s.version, s.id) AS seq
  FROM scoped s JOIN maxv m ON m.scope = s.scope
  WHERE s.dup_rn > 1
)
UPDATE routing_policies p
SET version = d.max_version + d.seq
FROM dups d
WHERE p.id = d.id;

-- 3. Constraints.
DROP INDEX IF EXISTS routing_policies_global_active;

CREATE UNIQUE INDEX IF NOT EXISTS routing_policies_one_active_global
  ON routing_policies ((TRUE)) WHERE org_id IS NULL AND is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS routing_policies_one_active_per_org
  ON routing_policies (org_id) WHERE org_id IS NOT NULL AND is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS routing_policies_global_version
  ON routing_policies (version) WHERE org_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS routing_policies_org_version
  ON routing_policies (org_id, version) WHERE org_id IS NOT NULL;
