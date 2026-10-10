// A WORKING CALENDAR FOR A FIXTURE, in the one shape `doc.hours` has (ADR 0021): the listed weekdays (0 is Sunday,
// default all) get the one window, the rest are off, and `dates` are overrides. Not a test file: the runner globs *.test.ts.
import { WEEKDAYS } from '../../shared/commands.js'

export const hoursOf = (win: [string, string] = ['00:00', '24:00'], days = [0, 1, 2, 3, 4, 5, 6], dates: Record<string, [string, string][]> = {}) =>
	({ week: Object.fromEntries(WEEKDAYS.map((k, i) => [k, days.includes(i) ? [win] : []])), dates })
