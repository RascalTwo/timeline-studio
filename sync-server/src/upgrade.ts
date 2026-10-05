// Pure, with no storage import, so the decision is testable without a bucket.
import { applyMigrations, type MigrationContext } from '../../shared/schedule.js'
import type { Doc } from '../../shared/commands.js'

/** WHAT AN UPGRADE ON LOAD WRITES, decided without touching storage: the
 *  migrated document, and the draft as it was if it differs from the newest
 *  saved version — `null` when that version already holds it, because saving
 *  twice with nothing changed adds no row (see `saveRoom`). */
export function upgradePlan(raw: Doc, lastSavedDoc: Doc | undefined, ctx: MigrationContext) {
	const before = !lastSavedDoc || JSON.stringify(lastSavedDoc) !== JSON.stringify(raw) ? raw : null
	return { doc: applyMigrations(structuredClone(raw), undefined, undefined, ctx), before }
}
