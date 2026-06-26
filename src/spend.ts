import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { parseCreditDetailsNanoAiu } from './parser';

const SPEND_LOOKBACK_DAYS = 30;
const SPEND_FILE_CACHE_VERSION = 4;
const SPEND_FILE_CACHE_MAX_AGE_MS = (SPEND_LOOKBACK_DAYS + 14) * 24 * 60 * 60 * 1000;
const SPEND_FILE_CACHE_NAME = 'spend-file-cache.json';

export interface ChatSessionDirEntry {
    dir: string;
    workspaceKey: string;
    workspaceLabel: string;
}

export interface SpendBucketBase {
    label: string;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    sessionCount: number;
}

export interface SpendBucket extends SpendBucketBase {
    models?: SpendModelBucket[];
    workspaces?: SpendWorkspaceBucket[];
}

export interface SpendModelBucket extends SpendBucketBase {
    key: string;
}

export interface SpendWorkspaceBucket extends SpendBucketBase {
    key: string;
}

export interface SpendSummary {
    today: SpendBucket;
    week?: SpendBucket;
    month?: SpendBucket;
    scannedFiles: number;
    generatedAt: number;
}

export interface SpendRequest {
    timestamp?: number;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    dedupeKey?: string;
}

export type SpendScanMode = 'today' | 'full';

interface SpendModelAccumulator {
    modelBuckets: Map<string, SpendModelBucket>;
    modelSessionSets: Map<string, Set<string>>;
}

interface SpendWorkspaceAccumulator {
    workspaceBuckets: Map<string, SpendWorkspaceBucket>;
    workspaceSessionSets: Map<string, Set<string>>;
}

interface SpendFileCacheEntry {
    parserVersion: number;
    path: string;
    mtimeMs: number;
    size: number;
    requests: SpendRequest[];
    parsedAt: number;
    lastSeenAt: number;
}

interface SpendFileCacheStore {
    version: number;
    entries: Record<string, SpendFileCacheEntry>;
}

interface ComputeSpendSummaryOptions {
    cacheFilePath?: string;
    now?: number;
}

interface SpendRequestCandidate {
    request: SpendRequest & { timestamp: number };
    sessionKey: string;
    workspace: ChatSessionDirEntry;
}

function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function requestIndexFromPath(pathParts: unknown[]): string | undefined {
    if (pathParts[0] !== 'requests' || pathParts.length < 2) {
        return undefined;
    }
    const index = pathParts[1];
    return typeof index === 'number' || typeof index === 'string' ? String(index) : undefined;
}

function parseCreditDetailsModel(detailsValue: unknown): string | undefined {
    if (typeof detailsValue !== 'string') {
        return undefined;
    }

    const match = detailsValue.match(/^\s*(.*?)\s*•\s*\d+(?:\.\d+)?\s+(?:ai\s+)?credits?\b/i);
    const model = match?.[1]?.trim();
    return model || undefined;
}

function normalizeSpendModel(modelValue: unknown): string | undefined {
    if (typeof modelValue !== 'string') {
        return undefined;
    }

    const model = modelValue.trim();
    if (!model) {
        return undefined;
    }

    return model.replace(/^copilot\//i, '');
}

function applySpendRequestModel(request: SpendRequest, modelValue: unknown): void {
    const model = normalizeSpendModel(modelValue);
    if (!model) {
        return;
    }

    if (request.model === 'Unknown model' || request.model === 'auto' || model !== 'auto') {
        request.model = model;
    }
}

function ensureSpendRequest(requests: Map<string, SpendRequest>, index: string): SpendRequest {
    let request = requests.get(index);
    if (!request) {
        request = {
            nanoAiu: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: 'Unknown model',
        };
        requests.set(index, request);
    }
    return request;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        const parsed = toFiniteNumber(value);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
}

function isInputTokenKey(key: unknown): boolean {
    return key === 'promptTokens' || key === 'inputTokens' || key === 'prompt_tokens' || key === 'input_tokens';
}

function isOutputTokenKey(key: unknown): boolean {
    return key === 'completionTokens' || key === 'outputTokens' || key === 'completion_tokens' || key === 'output_tokens';
}

function isNanoAiuKey(key: unknown): boolean {
    return key === 'copilotUsageNanoAiu' || key === 'nanoAiu' || key === 'nanoAiU';
}

function isResponseIdKey(key: unknown): boolean {
    return key === 'responseId' || key === 'response_id';
}

function applySpendRequestTokens(request: SpendRequest, value: any): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const metadata = value.result?.metadata ?? value.metadata;
    const usage = metadata?.usage ?? value.usage;
    const inputTokens = firstFiniteNumber(
        value.promptTokens,
        value.inputTokens,
        value.prompt_tokens,
        value.input_tokens,
        metadata?.promptTokens,
        metadata?.inputTokens,
        metadata?.prompt_tokens,
        metadata?.input_tokens,
        usage?.promptTokens,
        usage?.inputTokens,
        usage?.prompt_tokens,
        usage?.input_tokens
    );
    const outputTokens = firstFiniteNumber(
        value.completionTokens,
        value.outputTokens,
        value.completion_tokens,
        value.output_tokens,
        metadata?.completionTokens,
        metadata?.outputTokens,
        metadata?.completion_tokens,
        metadata?.output_tokens,
        usage?.completionTokens,
        usage?.outputTokens,
        usage?.completion_tokens,
        usage?.output_tokens
    );

    if (inputTokens !== undefined) {
        request.inputTokens = inputTokens;
    }
    if (outputTokens !== undefined) {
        request.outputTokens = outputTokens;
    }
}

function normalizeSpendDedupeKey(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const key = value.trim();
    return key ? `response:${key}` : undefined;
}

function readSpendRequestDedupeKey(value: any): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const metadata = value.result?.metadata ?? value.metadata;
    const usage = metadata?.usage ?? value.usage;
    return normalizeSpendDedupeKey(
        metadata?.responseId ??
        metadata?.response_id ??
        usage?.responseId ??
        usage?.response_id ??
        value.result?.responseId ??
        value.result?.response_id ??
        value.responseId ??
        value.response_id
    );
}

function applySpendRequestDedupeKey(request: SpendRequest, value: any, overwrite = false): void {
    const key = readSpendRequestDedupeKey(value);
    if (key && (overwrite || !request.dedupeKey)) {
        request.dedupeKey = key;
    }
}

function readSpendRequestNanoAiu(value: any): number {
    if (!value || typeof value !== 'object') {
        return 0;
    }

    const metadata = value.result?.metadata ?? value.metadata;
    const usage = metadata?.usage ?? value.usage;
    const direct = firstFiniteNumber(
        value.copilotUsageNanoAiu,
        value.nanoAiu,
        value.nanoAiU,
        metadata?.copilotUsageNanoAiu,
        metadata?.nanoAiu,
        metadata?.nanoAiU,
        usage?.copilotUsageNanoAiu,
        usage?.nanoAiu,
        usage?.nanoAiU
    );
    if (direct !== undefined) {
        return direct;
    }

    return parseCreditDetailsNanoAiu(value.result?.details ?? value.details);
}

function applySpendRequestNanoAiu(request: SpendRequest, value: any): void {
    const nanoAiu = readSpendRequestNanoAiu(value);
    if (nanoAiu > 0) {
        request.nanoAiu = nanoAiu;
    }
}

function updateSpendRequestFromValue(requests: Map<string, SpendRequest>, index: string, value: any): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const request = ensureSpendRequest(requests, index);
    const timestamp = toFiniteNumber(value.timestamp);
    if (timestamp !== undefined) {
        request.timestamp = timestamp;
    }

    const details = value.result?.details ?? value.details;
    applySpendRequestDedupeKey(request, value, true);
    applySpendRequestNanoAiu(request, value);
    applySpendRequestModel(request, parseCreditDetailsModel(details) ?? value.modelId ?? value.model);
    applySpendRequestTokens(request, value);
}

function updateSpendRequestFromPatch(request: SpendRequest, pathParts: unknown[], value: any): void {
    if (pathParts[2] === 'timestamp') {
        const timestamp = toFiniteNumber(value);
        if (timestamp !== undefined) {
            request.timestamp = timestamp;
        }
        return;
    }

    if (isInputTokenKey(pathParts[2])) {
        const inputTokens = toFiniteNumber(value);
        if (inputTokens !== undefined) {
            request.inputTokens = inputTokens;
        }
        return;
    }

    if (isOutputTokenKey(pathParts[2])) {
        const outputTokens = toFiniteNumber(value);
        if (outputTokens !== undefined) {
            request.outputTokens = outputTokens;
        }
        return;
    }

    if (isNanoAiuKey(pathParts[2])) {
        const nanoAiu = toFiniteNumber(value);
        if (nanoAiu !== undefined) {
            request.nanoAiu = nanoAiu;
        }
        return;
    }

    if (isResponseIdKey(pathParts[2])) {
        applySpendRequestDedupeKey(request, { responseId: value });
        return;
    }

    if (pathParts[2] === 'modelId' || pathParts[2] === 'model') {
        applySpendRequestModel(request, value);
        return;
    }

    if (pathParts[2] !== 'result') {
        return;
    }

    if (pathParts.length === 3) {
        applySpendRequestDedupeKey(request, { result: value }, true);
        applySpendRequestNanoAiu(request, { result: value });
        applySpendRequestModel(request, parseCreditDetailsModel(value?.details));
        applySpendRequestTokens(request, { result: value });
        return;
    }

    if (pathParts[3] === 'details') {
        applySpendRequestNanoAiu(request, { details: value });
        applySpendRequestModel(request, parseCreditDetailsModel(value));
        return;
    }

    if (pathParts[3] === 'metadata') {
        if (pathParts.length === 4) {
            applySpendRequestDedupeKey(request, { metadata: value }, true);
            applySpendRequestNanoAiu(request, { metadata: value });
            applySpendRequestTokens(request, { metadata: value });
        } else if (pathParts[4] === 'usage' && pathParts.length === 5) {
            applySpendRequestDedupeKey(request, { usage: value }, true);
            applySpendRequestNanoAiu(request, { usage: value });
            applySpendRequestTokens(request, { usage: value });
        } else if (isResponseIdKey(pathParts[4])) {
            applySpendRequestDedupeKey(request, { metadata: { responseId: value } }, true);
        } else if (pathParts[4] === 'usage' && isInputTokenKey(pathParts[5])) {
            const inputTokens = toFiniteNumber(value);
            if (inputTokens !== undefined) {
                request.inputTokens = inputTokens;
            }
        } else if (pathParts[4] === 'usage' && isOutputTokenKey(pathParts[5])) {
            const outputTokens = toFiniteNumber(value);
            if (outputTokens !== undefined) {
                request.outputTokens = outputTokens;
            }
        } else if (pathParts[4] === 'usage' && isNanoAiuKey(pathParts[5])) {
            const nanoAiu = toFiniteNumber(value);
            if (nanoAiu !== undefined) {
                request.nanoAiu = nanoAiu;
            }
        } else if (pathParts[4] === 'usage' && isResponseIdKey(pathParts[5])) {
            applySpendRequestDedupeKey(request, { usage: { responseId: value } }, true);
        } else if (isInputTokenKey(pathParts[4])) {
            const inputTokens = toFiniteNumber(value);
            if (inputTokens !== undefined) {
                request.inputTokens = inputTokens;
            }
        } else if (isOutputTokenKey(pathParts[4])) {
            const outputTokens = toFiniteNumber(value);
            if (outputTokens !== undefined) {
                request.outputTokens = outputTokens;
            }
        } else if (isNanoAiuKey(pathParts[4])) {
            const nanoAiu = toFiniteNumber(value);
            if (nanoAiu !== undefined) {
                request.nanoAiu = nanoAiu;
            }
        }
    } else {
        applySpendRequestDedupeKey(request, { result: value }, true);
        applySpendRequestNanoAiu(request, { result: value });
        applySpendRequestTokens(request, { result: value });
    }
}

function readSpendLines(filePath: string, onLine: (line: string) => void): void {
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(64 * 1024);
        let carry = '';

        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }

            carry += decoder.write(buffer.subarray(0, bytesRead));
            let newlineIndex = carry.indexOf('\n');
            while (newlineIndex >= 0) {
                onLine(carry.slice(0, newlineIndex));
                carry = carry.slice(newlineIndex + 1);
                newlineIndex = carry.indexOf('\n');
            }
        }

        carry += decoder.end();
        if (carry) {
            onLine(carry);
        }
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore close failures */ }
        }
    }
}

export function readSpendRequestsFromChatSession(filePath: string): SpendRequest[] {
    const requests = new Map<string, SpendRequest>();
    let nextAppendIndex = 0;

    try {
        readSpendLines(filePath, line => {
            if (!line.trim() || !line.includes('requests')) {
                return;
            }

            let raw: any;
            try {
                raw = JSON.parse(line);
            } catch {
                return;
            }

            if (raw.kind === 0 && Array.isArray(raw.v?.requests)) {
                raw.v.requests.forEach((request: any, index: number) => {
                    updateSpendRequestFromValue(requests, String(index), request);
                });
                nextAppendIndex = raw.v.requests.length;
                return;
            }

            if (!Array.isArray(raw.k) || raw.k[0] !== 'requests') {
                return;
            }

            if (raw.kind === 2 && raw.k.length === 1 && Array.isArray(raw.v)) {
                const startIndex = toFiniteNumber(raw.i) ?? nextAppendIndex;
                raw.v.forEach((request: any, offset: number) => {
                    updateSpendRequestFromValue(requests, String(startIndex + offset), request);
                });
                nextAppendIndex = Math.max(nextAppendIndex, startIndex + raw.v.length);
                return;
            }

            const index = requestIndexFromPath(raw.k);
            if (index === undefined) {
                return;
            }
            const numericIndex = toFiniteNumber(index);
            if (numericIndex !== undefined) {
                nextAppendIndex = Math.max(nextAppendIndex, numericIndex + 1);
            }

            if (raw.kind === 3) {
                requests.delete(index);
                return;
            }

            if (raw.k.length === 2) {
                updateSpendRequestFromValue(requests, index, raw.v);
                return;
            }

            updateSpendRequestFromPatch(ensureSpendRequest(requests, index), raw.k, raw.v);
        });
    } catch {
        return [];
    }

    return [...requests.values()]
        .filter(request => request.nanoAiu > 0 || request.inputTokens > 0 || request.outputTokens > 0);
}

function createSpendBucket(label: string): SpendBucket {
    return { label, nanoAiu: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, sessionCount: 0 };
}

function createSpendModelBucket(key: string, label: string): SpendModelBucket {
    return { key, ...createSpendBucket(label) };
}

function createSpendWorkspaceBucket(key: string, label: string): SpendWorkspaceBucket {
    return { key, ...createSpendBucket(label) };
}

function createSpendModelAccumulator(): SpendModelAccumulator {
    return {
        modelBuckets: new Map<string, SpendModelBucket>(),
        modelSessionSets: new Map<string, Set<string>>(),
    };
}

function createSpendWorkspaceAccumulator(): SpendWorkspaceAccumulator {
    return {
        workspaceBuckets: new Map<string, SpendWorkspaceBucket>(),
        workspaceSessionSets: new Map<string, Set<string>>(),
    };
}

function addToSpendBucket(bucket: SpendBucketBase, request: SpendRequest, sessionSet: Set<string>, sessionId: string): void {
    bucket.nanoAiu += request.nanoAiu;
    bucket.inputTokens += request.inputTokens;
    bucket.outputTokens += request.outputTokens;
    bucket.requestCount++;
    sessionSet.add(sessionId);
    bucket.sessionCount = sessionSet.size;
}

function addToSpendModelBucket(
    buckets: Map<string, SpendModelBucket>,
    sessionSets: Map<string, Set<string>>,
    key: string,
    label: string,
    request: SpendRequest,
    sessionId: string
): void {
    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = createSpendModelBucket(key, label);
        buckets.set(key, bucket);
    }

    let sessionSet = sessionSets.get(key);
    if (!sessionSet) {
        sessionSet = new Set<string>();
        sessionSets.set(key, sessionSet);
    }

    addToSpendBucket(bucket, request, sessionSet, sessionId);
}

function sortedSpendModelBuckets(buckets: Map<string, SpendModelBucket>): SpendModelBucket[] {
    return [...buckets.values()].sort((a, b) => {
        if (b.nanoAiu !== a.nanoAiu) {
            return b.nanoAiu - a.nanoAiu;
        }
        return a.label.localeCompare(b.label);
    });
}

function sortedSpendWorkspaceBuckets(buckets: Map<string, SpendWorkspaceBucket>): SpendWorkspaceBucket[] {
    return [...buckets.values()].sort((a, b) => {
        if (b.nanoAiu !== a.nanoAiu) {
            return b.nanoAiu - a.nanoAiu;
        }
        return a.label.localeCompare(b.label);
    });
}

function addToSpendModels(accumulator: SpendModelAccumulator, request: SpendRequest, sessionId: string): void {
    addToSpendModelBucket(
        accumulator.modelBuckets,
        accumulator.modelSessionSets,
        request.model,
        request.model,
        request,
        sessionId
    );
}

function addToSpendWorkspaces(
    accumulator: SpendWorkspaceAccumulator,
    request: SpendRequest,
    sessionId: string,
    workspace: ChatSessionDirEntry
): void {
    let bucket = accumulator.workspaceBuckets.get(workspace.workspaceKey);
    if (!bucket) {
        bucket = createSpendWorkspaceBucket(workspace.workspaceKey, workspace.workspaceLabel);
        accumulator.workspaceBuckets.set(workspace.workspaceKey, bucket);
    }

    let sessionSet = accumulator.workspaceSessionSets.get(workspace.workspaceKey);
    if (!sessionSet) {
        sessionSet = new Set<string>();
        accumulator.workspaceSessionSets.set(workspace.workspaceKey, sessionSet);
    }

    addToSpendBucket(bucket, request, sessionSet, sessionId);
}

function shouldReplaceSpendCandidate(existing: SpendRequestCandidate, candidate: SpendRequestCandidate): boolean {
    if (candidate.request.timestamp !== existing.request.timestamp) {
        return candidate.request.timestamp < existing.request.timestamp;
    }

    return candidate.sessionKey.localeCompare(existing.sessionKey) < 0;
}

function collectSpendCandidate(
    dedupedCandidates: Map<string, SpendRequestCandidate>,
    undedupedCandidates: SpendRequestCandidate[],
    candidate: SpendRequestCandidate
): void {
    if (!candidate.request.dedupeKey) {
        undedupedCandidates.push(candidate);
        return;
    }

    const existing = dedupedCandidates.get(candidate.request.dedupeKey);
    if (!existing || shouldReplaceSpendCandidate(existing, candidate)) {
        dedupedCandidates.set(candidate.request.dedupeKey, candidate);
    }
}

function finalizeSpendModels(accumulator: SpendModelAccumulator): SpendModelBucket[] {
    return sortedSpendModelBuckets(accumulator.modelBuckets);
}

function finalizeSpendWorkspaces(accumulator: SpendWorkspaceAccumulator): SpendWorkspaceBucket[] {
    return sortedSpendWorkspaceBuckets(accumulator.workspaceBuckets);
}

function createSpendFileCacheStore(): SpendFileCacheStore {
    return { version: SPEND_FILE_CACHE_VERSION, entries: {} };
}

export function getSpendFileCachePath(globalStoragePath: string | undefined): string | undefined {
    return globalStoragePath ? path.join(globalStoragePath, SPEND_FILE_CACHE_NAME) : undefined;
}

function normalizedCachePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function spendFileCacheKey(filePath: string): string {
    return crypto.createHash('sha256').update(normalizedCachePath(filePath)).digest('hex');
}

function readSpendFileCache(cacheFilePath: string | undefined): SpendFileCacheStore {
    if (!cacheFilePath) {
        return createSpendFileCacheStore();
    }

    try {
        const raw = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
        if (raw?.version !== SPEND_FILE_CACHE_VERSION || !raw.entries || typeof raw.entries !== 'object') {
            return createSpendFileCacheStore();
        }
        return { version: SPEND_FILE_CACHE_VERSION, entries: raw.entries };
    } catch {
        return createSpendFileCacheStore();
    }
}

function writeSpendFileCache(cacheFilePath: string | undefined, store: SpendFileCacheStore): void {
    if (!cacheFilePath) {
        return;
    }

    try {
        fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
        const tempFile = `${cacheFilePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(store));
        fs.renameSync(tempFile, cacheFilePath);
    } catch {
        // The cache is only an optimization; spend summaries can still be recomputed.
    }
}

function getCachedSpendRequests(
    store: SpendFileCacheStore,
    filePath: string,
    stat: fs.Stats
): SpendRequest[] | undefined {
    const entry = store.entries[spendFileCacheKey(filePath)];
    if (!entry || entry.parserVersion !== SPEND_FILE_CACHE_VERSION) {
        return undefined;
    }

    if (
        entry.path !== normalizedCachePath(filePath) ||
        entry.mtimeMs !== stat.mtimeMs ||
        entry.size !== stat.size ||
        !Array.isArray(entry.requests)
    ) {
        return undefined;
    }

    return entry.requests;
}

function updateSpendFileCache(
    store: SpendFileCacheStore,
    filePath: string,
    stat: fs.Stats,
    requests: SpendRequest[],
    now: number
): void {
    store.entries[spendFileCacheKey(filePath)] = {
        parserVersion: SPEND_FILE_CACHE_VERSION,
        path: normalizedCachePath(filePath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        requests,
        parsedAt: now,
        lastSeenAt: now,
    };
}

function pruneSpendFileCache(store: SpendFileCacheStore, now: number): boolean {
    let changed = false;
    for (const [key, entry] of Object.entries(store.entries)) {
        const lastSeenAt = toFiniteNumber(entry?.lastSeenAt) ?? toFiniteNumber(entry?.parsedAt) ?? 0;
        if (now - lastSeenAt > SPEND_FILE_CACHE_MAX_AGE_MS) {
            delete store.entries[key];
            changed = true;
        }
    }
    return changed;
}

export function computeSpendSummaryFromChatSessionDirs(
    mode: SpendScanMode,
    chatSessionDirs: ChatSessionDirEntry[],
    options: ComputeSpendSummaryOptions = {}
): SpendSummary {
    const now = options.now ?? Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayCutoff = todayStart.getTime();
    const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const monthCutoff = now - SPEND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const includeHistory = mode === 'full';

    const summary: SpendSummary = {
        today: createSpendBucket('Today'),
        week: includeHistory ? createSpendBucket('Last 7 days') : undefined,
        month: includeHistory ? createSpendBucket('Last 30 days') : undefined,
        scannedFiles: 0,
        generatedAt: now,
    };
    const todaySessions = new Set<string>();
    const weekSessions = new Set<string>();
    const monthSessions = new Set<string>();
    const todayWorkspaces = createSpendWorkspaceAccumulator();
    const weekWorkspaces = createSpendWorkspaceAccumulator();
    const monthWorkspaces = createSpendWorkspaceAccumulator();
    const todayModels = createSpendModelAccumulator();
    const weekModels = createSpendModelAccumulator();
    const monthModels = createSpendModelAccumulator();
    const fileCutoff = includeHistory ? monthCutoff : todayCutoff;
    const fileCache = readSpendFileCache(options.cacheFilePath);
    const dedupedCandidates = new Map<string, SpendRequestCandidate>();
    const undedupedCandidates: SpendRequestCandidate[] = [];
    let fileCacheChanged = false;

    for (const chatDir of chatSessionDirs) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(chatDir.dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }

            const filePath = path.join(chatDir.dir, entry.name);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }
            if (stat.mtimeMs < fileCutoff) {
                continue;
            }

            summary.scannedFiles++;
            const sessionId = path.basename(entry.name, '.jsonl');
            const sessionKey = `${chatDir.workspaceKey}:${sessionId}`;
            let requests = getCachedSpendRequests(fileCache, filePath, stat);
            if (!requests) {
                requests = readSpendRequestsFromChatSession(filePath);
                updateSpendFileCache(fileCache, filePath, stat, requests, now);
                fileCacheChanged = true;
            }

            for (const request of requests) {
                if (request.timestamp === undefined) {
                    continue;
                }

                collectSpendCandidate(dedupedCandidates, undedupedCandidates, {
                    request: request as SpendRequest & { timestamp: number },
                    sessionKey,
                    workspace: chatDir,
                });
            }
        }
    }

    const candidates = [...dedupedCandidates.values(), ...undedupedCandidates];
    for (const { request, sessionKey, workspace } of candidates) {
        const timestamp = request.timestamp;
        if (timestamp >= todayCutoff) {
            addToSpendBucket(summary.today, request, todaySessions, sessionKey);
            addToSpendWorkspaces(todayWorkspaces, request, sessionKey, workspace);
            addToSpendModels(todayModels, request, sessionKey);
        }
        if (includeHistory && summary.week && summary.month) {
            if (timestamp >= monthCutoff) {
                addToSpendBucket(summary.month, request, monthSessions, sessionKey);
                addToSpendWorkspaces(monthWorkspaces, request, sessionKey, workspace);
                addToSpendModels(monthModels, request, sessionKey);
            }
            if (timestamp >= weekCutoff) {
                addToSpendBucket(summary.week, request, weekSessions, sessionKey);
                addToSpendWorkspaces(weekWorkspaces, request, sessionKey, workspace);
                addToSpendModels(weekModels, request, sessionKey);
            }
        }
    }

    summary.today.workspaces = finalizeSpendWorkspaces(todayWorkspaces);
    summary.today.models = finalizeSpendModels(todayModels);
    if (includeHistory) {
        if (summary.week) {
            summary.week.workspaces = finalizeSpendWorkspaces(weekWorkspaces);
            summary.week.models = finalizeSpendModels(weekModels);
        }
        if (summary.month) {
            summary.month.workspaces = finalizeSpendWorkspaces(monthWorkspaces);
            summary.month.models = finalizeSpendModels(monthModels);
        }
    }

    if (pruneSpendFileCache(fileCache, now)) {
        fileCacheChanged = true;
    }
    if (fileCacheChanged) {
        writeSpendFileCache(options.cacheFilePath, fileCache);
    }

    return summary;
}

const SQLITE_WORKSPACE_KEY = 'otel-sqlite';
const SQLITE_WORKSPACE_LABEL = 'OTel Traces';

export function computeSpendSummaryFromSqlite(
    mode: SpendScanMode,
    requests: SpendRequest[],
    options: { now?: number } = {}
): SpendSummary {
    const now = options.now ?? Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayCutoff = todayStart.getTime();
    const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const monthCutoff = now - SPEND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const includeHistory = mode === 'full';

    const sqliteWorkspace: ChatSessionDirEntry = {
        dir: SQLITE_WORKSPACE_KEY,
        workspaceKey: SQLITE_WORKSPACE_KEY,
        workspaceLabel: SQLITE_WORKSPACE_LABEL,
    };

    const summary: SpendSummary = {
        today: createSpendBucket('Today'),
        week: includeHistory ? createSpendBucket('Last 7 days') : undefined,
        month: includeHistory ? createSpendBucket('Last 30 days') : undefined,
        scannedFiles: 0,
        generatedAt: now,
    };
    const todaySessions = new Set<string>();
    const weekSessions = new Set<string>();
    const monthSessions = new Set<string>();
    const todayWorkspaces = createSpendWorkspaceAccumulator();
    const weekWorkspaces = createSpendWorkspaceAccumulator();
    const monthWorkspaces = createSpendWorkspaceAccumulator();
    const todayModels = createSpendModelAccumulator();
    const weekModels = createSpendModelAccumulator();
    const monthModels = createSpendModelAccumulator();

    const dedupedCandidates = new Map<string, SpendRequestCandidate>();
    const undedupedCandidates: SpendRequestCandidate[] = [];

    for (const request of requests) {
        if (request.timestamp === undefined) {
            continue;
        }
        collectSpendCandidate(dedupedCandidates, undedupedCandidates, {
            request: request as SpendRequest & { timestamp: number },
            sessionKey: request.dedupeKey ?? String(request.timestamp),
            workspace: sqliteWorkspace,
        });
    }

    const candidates = [...dedupedCandidates.values(), ...undedupedCandidates];
    for (const { request, sessionKey, workspace } of candidates) {
        const timestamp = request.timestamp;
        if (timestamp >= todayCutoff) {
            addToSpendBucket(summary.today, request, todaySessions, sessionKey);
            addToSpendWorkspaces(todayWorkspaces, request, sessionKey, workspace);
            addToSpendModels(todayModels, request, sessionKey);
        }
        if (includeHistory && summary.week && summary.month) {
            if (timestamp >= monthCutoff) {
                addToSpendBucket(summary.month, request, monthSessions, sessionKey);
                addToSpendWorkspaces(monthWorkspaces, request, sessionKey, workspace);
                addToSpendModels(monthModels, request, sessionKey);
            }
            if (timestamp >= weekCutoff) {
                addToSpendBucket(summary.week, request, weekSessions, sessionKey);
                addToSpendWorkspaces(weekWorkspaces, request, sessionKey, workspace);
                addToSpendModels(weekModels, request, sessionKey);
            }
        }
    }

    summary.today.workspaces = finalizeSpendWorkspaces(todayWorkspaces);
    summary.today.models = finalizeSpendModels(todayModels);
    if (includeHistory) {
        if (summary.week) {
            summary.week.workspaces = finalizeSpendWorkspaces(weekWorkspaces);
            summary.week.models = finalizeSpendModels(weekModels);
        }
        if (summary.month) {
            summary.month.workspaces = finalizeSpendWorkspaces(monthWorkspaces);
            summary.month.models = finalizeSpendModels(monthModels);
        }
    }

    return summary;
}
