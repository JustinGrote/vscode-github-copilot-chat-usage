import * as path from 'path';
import * as fs from 'fs';
import { SpendRequest } from './spend';

type SpanRow = {
    span_id: string;
    conversation_id: string | null;
    chat_session_id: string | null;
    request_model: string | null;
    response_model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_tokens: number | null;
    start_time_ms: number;
};

const DB_REL_PATH = 'github.copilot-chat/agent-traces.db';

export function getOtelDbPaths(): string[] {
    const candidates: string[] = [];
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const appData = process.env.APPDATA;

    if (appData) {
        candidates.push(path.join(appData, 'Code', 'User', 'globalStorage', DB_REL_PATH));
        candidates.push(path.join(appData, 'Code - Insiders', 'User', 'globalStorage', DB_REL_PATH));
    }

    if (home) {
        // macOS
        candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', DB_REL_PATH));
        candidates.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', DB_REL_PATH));
        // Linux
        candidates.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', DB_REL_PATH));
        candidates.push(path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', DB_REL_PATH));
    }

    return [...new Set(candidates)].filter(p => fs.existsSync(p));
}

function modelFromRow(row: SpanRow): string {
    const raw = row.response_model ?? row.request_model ?? '';
    return raw.replace(/^github-copilot\//, '') || 'Unknown model';
}

export function readSpendRequestsFromSqlite(dbPath: string, sinceMs?: number): SpendRequest[] {
    let Database: (new (path: string, options?: object) => any) | undefined;
    try {
        // Dynamic require so the module is optional at compile time.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        Database = require('better-sqlite3');
    } catch {
        return [];
    }

    if (!Database) {
        return [];
    }

    let db: any;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
        return [];
    }

    try {
        const baseQuery = `
            SELECT span_id, conversation_id, chat_session_id,
                   request_model, response_model,
                   input_tokens, output_tokens, cached_tokens,
                   start_time_ms
            FROM spans
            WHERE operation_name = 'chat'
              AND provider_name = 'github'
        `;

        const rows: SpanRow[] = sinceMs !== undefined
            ? db.prepare(baseQuery + ' AND start_time_ms >= ?').all(sinceMs) as SpanRow[]
            : db.prepare(baseQuery).all() as SpanRow[];

        const requests: SpendRequest[] = [];
        for (const row of rows) {
            if (row.input_tokens === null && row.output_tokens === null) {
                continue;
            }

            requests.push({
                timestamp: row.start_time_ms,
                nanoAiu: 0,
                inputTokens: row.input_tokens ?? 0,
                outputTokens: row.output_tokens ?? 0,
                model: modelFromRow(row),
                dedupeKey: `otel-span:${row.span_id}`,
            });
        }

        return requests;
    } catch {
        return [];
    } finally {
        try { db.close(); } catch { /* ignore */ }
    }
}
