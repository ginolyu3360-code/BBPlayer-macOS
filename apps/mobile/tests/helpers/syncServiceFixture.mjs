import { Buffer } from 'node:buffer'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'

import { expoClient } from './expoDriver.mjs'

const require = createRequire(new URL('../../package.json', import.meta.url))
const orm = require('drizzle-orm')
const sqlite = require('drizzle-orm/sqlite-core')
const { drizzle } = require('drizzle-orm/expo-sqlite/driver')
const fractional = require('fractional-indexing')
function loadSync(name, exports, bindings = {}) {
	const source = stripTypeScriptTypes(
		readFileSync(
			new URL(`../../src/lib/sync/${name}.ts`, import.meta.url),
			'utf8',
		),
		{ mode: 'transform' },
	)
		.replace(/^import[\s\S]*?from ['"][^'"]+['"];?$/gm, '')
		.replace(/^export /gm, '')
	return new vm.Script(`${source};({${exports}})`).runInNewContext({
		...bindings,
		Buffer,
		URL,
	})
}
const protocol = loadSync(
	'protocol',
	'canonicalJSON,validateSyncOperation,wireSourceKey,mobileSourceKey',
)
const engine = loadSync('engine', 'SyncEngine,syncConflicts', protocol)
const order = loadSync('order', 'causalNetworkOrder')
const projection = loadSync('libraryProjection', 'projectSyncLibrary', {
	...protocol,
	...engine,
	...order,
	...fractional,
})
const recording = loadSync(
	'localRecording',
	'activateLocalSync,rebaselineLocalSync,localRecorder,playlistState,saveManualLyrics',
	{ ...protocol, ...engine, ...projection },
)
const bridge = loadSync('drizzleRecording', 'drizzleSyncDatabase', {
	sql: orm.sql,
})

function loadService(kind, imports) {
	const source = stripTypeScriptTypes(
		readFileSync(
			new URL(`../../src/lib/services/${kind}Service.ts`, import.meta.url),
			'utf8',
		),
		{ mode: 'transform' },
	)
		.replace(
			/^import \* as (\w+) from '([^']+)'/gm,
			(_, name, id) => `const ${name}=imports[${JSON.stringify(id)}]`,
		)
		.replace(
			/^import \{([\s\S]*?)\} from '([^']+)'/gm,
			(_, fields, id) =>
				`const {${fields.replaceAll(' as ', ': ')}}=imports[${JSON.stringify(id)}]`,
		)
		.replace(
			/^import (\w+) from '([^']+)'/gm,
			(_, name, id) => `const ${name}=imports[${JSON.stringify(id)}]`,
		)
		.replace(/^import '[^']+';?$/gm, '')
		.replace(/^export /gm, '')
	return new vm.Script(`${source};${kind}Service`).runInNewContext({ imports })
}
export function syncServiceFixture() {
	const db = new DatabaseSync(':memory:', {
		enableDoubleQuotedStringLiterals: true,
	})
	const directory = new URL('../../drizzle/', import.meta.url)
	for (const file of readdirSync(directory)
		.filter((name) => /^\d+.*\.sql$/.test(name))
		.sort())
		db.exec(readFileSync(new URL(file, directory), 'utf8'))
	if (
		db
			.prepare('PRAGMA table_info(playlist_tracks)')
			.all()
			.some((row) => row.name === 'order')
	)
		db.exec('ALTER TABLE playlist_tracks DROP COLUMN [order]')
	db.exec('PRAGMA foreign_keys=ON')
	const rawSchema = stripTypeScriptTypes(
		readFileSync(
			new URL('../../src/lib/db/schema.ts', import.meta.url),
			'utf8',
		),
	)
	const names = [...rawSchema.matchAll(/export const (\w+)/g)].map(
		(match) => match[1],
	)
	const schema = new vm.Script(
		`${rawSchema.replace(/^import \{([\s\S]*?)\} from '[^']+'/gm, (_, fields) => `const {${fields.replaceAll(' as ', ': ')}}=bindings`).replace(/^export /gm, '')};({${names.join(',')}})`,
	).runInNewContext({ bindings: { ...orm, ...sqlite } })
	const driver = drizzle(expoClient(db), { schema })
	class ServiceError extends Error {}
	const imports = {
		'@sentry/react-native': { startSpan: (_, body) => body() },
		'drizzle-orm': orm,
		'fractional-indexing': fractional,
		neverthrow: require('neverthrow'),
		'@/lib/db/db': driver,
		'@/lib/db/schema': schema,
		'@/lib/errors': { ServiceError },
		'@/lib/errors/service': {
			DatabaseError: Error,
			createPlaylistNotFound: () => new ServiceError('Missing playlist'),
			createTrackNotInPlaylist: () => new ServiceError('Missing track'),
			createValidationError: (message) => new ServiceError(message),
		},
		'@/lib/sync/drizzleRecording': bridge,
		'@/lib/sync/localRecording': recording,
		'@/utils/log': { extend: () => ({ warning() {} }) },
		'./genKey': () => {},
	}
	const tracks = loadService('track', imports)
	imports['./trackService'] = { trackService: tracks }
	const playlists = loadService('playlist', imports)
	const raw = bridge.drizzleSyncDatabase(driver)
	const recorder = recording.activateLocalSync(raw)
	const replacementSource = stripTypeScriptTypes(
		readFileSync(
			new URL('../../src/lib/services/songIdentityService.ts', import.meta.url),
			'utf8',
		),
	)
		.replace(/^import .*$/gm, '')
		.replace(/^export /gm, '')
	const { replaceSongSource } = new vm.Script(
		`${replacementSource};({replaceSongSource})`,
	).runInNewContext(recording)
	return {
		db,
		driver,
		raw,
		recorder,
		tracks,
		playlists,
		...recording,
		replaceSongSource,
	}
}
