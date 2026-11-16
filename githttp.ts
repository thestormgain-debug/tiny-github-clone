// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0) over the store.
import {
  FLUSH_PKT,
  DELIM_PKT,
  ZERO_OID,
  buildTree,
  hashObject,
  parseCommit,
  parsePktLines,
  parseTree,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type Pkt,
  type TreeEntry,
} from './gitcore.ts';
import {
  applyReceivePack,
  collectReachable,
  getObject,
  peel,
  putObject,
  walkCommits,
  type Repository,
} from './store.ts';

const AGENT = 'ghforge/1.0';

function dataPkt(text: string): Buffer {
  return pktLine(text.endsWith('\n') ? text : `${text}\n`);
}

function sideband(band: number, data: Buffer): Buffer {
  // Split into <=65519-byte sideband packets.
  const chunks: Buffer[] = [];
  const max = 65515;
  for (let offset = 0; offset < data.length || offset === 0; offset += max) {
    const slice = data.subarray(offset, offset + max);
    chunks.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
    if (slice.length === 0) break;
  }
  return Buffer.concat(chunks);
}

interface RepoLookup {
  (owner: string, repo: string): Repository | null;
}

interface GitRequest {
  method: 'GET' | 'POST';
  path: string;
  query: URLSearchParams;
  protocolHeader: string | null;
  body: Buffer;
}

interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

// ---------------------------------------------------------------- advertisement

function v2Advertisement(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT, dataPkt('version 2')];
  if (service === 'git-upload-pack') {
    parts.push(
      dataPkt(`agent=${AGENT}`),
      dataPkt('ls-refs=unborn'),
      dataPkt('fetch=shallow filter ofs-delta'),
      dataPkt('object-format=sha1'),
      FLUSH_PKT,
    );
  }
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repository | null, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  if (service === 'git-receive-pack') {
    const capabilities = [
      'report-status',
      'report-status-v2',
      'delete-refs',
      'side-band-64k',
      'ofs-delta',
      `agent=${AGENT}`,
      'object-format=sha1',
    ].join(' ');
    if (!repo || repo.refs.size === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    } else {
      let first = true;
      for (const name of orderedRefs(repo)) {
        const oid = repo.refs.get(name)!;
        const line = first ? `${oid} ${name}\0${capabilities}\n` : `${oid} ${name}\n`;
        parts.push(pktLine(line));
        first = false;
      }
    }
    parts.push(FLUSH_PKT);
    return Buffer.concat(parts);
  }
  const capabilities = [
    'multi_ack_detailed',
    'multi_ack',
    'side-band-64k',
    'side-band',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'no-progress',
    'include-tag',
    `symref=HEAD:refs/heads/${repo?.defaultBranch ?? 'main'}`,
    `agent=${AGENT}`,
    'object-format=sha1',
  ].join(' ');
  if (!repo || repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`), FLUSH_PKT);
    return Buffer.concat(parts);
  }
  let first = true;
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  parts.push(pktLine(`${head} HEAD\0${capabilities}\n`));
  first = false;
  void first;
  for (const name of orderedRefs(repo)) {
    parts.push(pktLine(`${repo.refs.get(name)} ${name}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function orderedRefs(repo: Repository): string[] {
  return [...repo.refs.keys()].sort((a, b) => (a === 'HEAD' ? -1 : b === 'HEAD' ? 1 : a < b ? -1 : 1));
}

// ---------------------------------------------------------------- v2 commands

function parseV2Request(body: Buffer): { command: string; args: Map<string, string | true> } {
  const packets = parsePktLines(body);
  let command = '';
  const args = new Map<string, string | true>();
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'delim') pastDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('object-format=') || line.startsWith('agent=') || line.startsWith('session-id=')) continue;
    const space = line.indexOf(' ');
    if (space < 0) args.set(line, true);
    else args.set(line.slice(0, space), line.slice(space + 1));
  }
  return { command, args };
}

function lsRefsResponse(repo: Repository, args: Map<string, string | true>): Buffer {
  const symrefs = args.has('symrefs');
  const wantsPeel = args.has('peel');
  const unborn = args.has('unborn');
  const prefixes: string[] = [];
  for (const [key, value] of args) if (key === 'ref-prefix' && typeof value === 'string') prefixes.push(value);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const emit = (line: string): void => parts.push(pktLine(`${line}\n`));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid === undefined) {
    if (unborn && matches('HEAD')) {
      emit(symrefs ? `unborn HEAD symref-target:${headTarget}` : 'unborn HEAD');
    }
  } else if (matches('HEAD')) {
    emit(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
  }
  for (const name of orderedRefs(repo)) {
    if (name === 'HEAD') continue;
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let suffix = '';
    if (wantsPeel) {
      const peeled = peel(repo, oid);
      if (peeled !== oid) suffix = ` peeled:${peeled}`;
    }
    emit(`${oid} ${name}${suffix}`);
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch object selection

interface FetchSpec {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
}

function parseFetchArgs(args: Map<string, string | true>, pktHaves: string[]): FetchSpec {
  const spec: FetchSpec = { wants: [], haves: [], depth: null, shallow: [] };
  for (const [key, value] of args) {
    if (key === 'want' && typeof value === 'string') spec.wants.push(value);
    else if (key === 'shallow' && typeof value === 'string') spec.shallow.push(value);
    else if (key === 'deepen' && typeof value === 'string') spec.depth = Number.parseInt(value, 10);
  }
  spec.haves = pktHaves;
  return spec;
}

function parseV0Fetch(body: Buffer): FetchSpec {
  const packets = parsePktLines(body);
  const spec: FetchSpec = { wants: [], haves: [], depth: null, shallow: [] };
  let section: 'wants' | 'negotiation' = 'wants';
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'flush') section = 'negotiation';
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      spec.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('have ')) {
      spec.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      spec.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      spec.depth = Number.parseInt(line.slice(7).trim(), 10);
    } else if (line === 'done') {
      void first;
    }
    first = false;
  }
  return spec;
}

/** Select the objects a fetch must send: closure(wants, depth) minus closure(haves), shallow-aware. */
function selectFetchObjects(repo: Repository, spec: FetchSpec): { objects: Array<{ type: import('./gitcore.ts').ObjType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const wantSet = [...new Set(spec.wants)].filter((oid) => repo.objects.has(oid));
  const haveClosure = new Set<string>();
  if (spec.haves.length > 0) {
    // What the client holds: ancestors stop at the client's shallow boundary (it holds the
    // boundary commit and its tree, but nothing above it).
    const clientShallow0 = new Set(spec.shallow);
    const seen = new Set<string>();
    const queue: string[] = [...spec.haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      haveClosure.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        haveClosure.add(commit.tree);
        queue.push(commit.tree);
        if (!clientShallow0.has(oid)) queue.push(...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  }
  const objects: Array<{ type: import('./gitcore.ts').ObjType; data: Buffer }> = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const sent = new Set<string>();
  const sendObject = (oid: string, force = false): void => {
    if (sent.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    if (!force && haveClosure.has(oid)) return;
    sent.add(oid);
    objects.push({ type: object.type, data: object.data });
  };
  const sendTree = (treeOid: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    sendObject(treeOid);
    for (const entry of parseTree(object.data)) {
      const child = repo.objects.get(entry.oid);
      if (child && child.type === 'tree') sendTree(entry.oid);
      else sendObject(entry.oid);
    }
  };
  const clientShallow = new Set(spec.shallow);
  for (const want of wantSet) {
    // An annotated tag want delivers the tag object and its peeled commit history.
    let walkTip = want;
    const wantObject = repo.objects.get(want);
    if (wantObject && wantObject.type === 'tag') {
      sendObject(want, true);
      const match = /^object ([0-9a-f]{40})/m.exec(wantObject.data.toString('utf8'));
      if (match) walkTip = match[1];
    }
    const commits = walkCommits(repo, walkTip, spec.depth ?? Number.POSITIVE_INFINITY);
    const included = new Set(commits.map((entry) => entry.oid));
    const lastGeneration = new Map<number, string[]>();
    for (const entry of commits) {
      const bucket = lastGeneration.get(entry.depth) ?? [];
      bucket.push(entry.oid);
      lastGeneration.set(entry.depth, bucket);
    }
    for (const entry of commits) {
      // The client already holds this commit (with its full tree) — resend nothing.
      if (haveClosure.has(entry.oid)) continue;
      sendObject(entry.oid, true);
      sendTree(entry.commit.tree);
      // A commit whose parents are neither included nor already held by the client is a new shallow boundary.
      const boundary = entry.commit.parents.some((parent) => !included.has(parent) && !haveClosure.has(parent));
      if (boundary && !clientShallow.has(entry.oid)) shallow.push(entry.oid);
      if (clientShallow.has(entry.oid) && !boundary) unshallow.push(entry.oid);
    }
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- request entry points

export function handleGitRequest(
  lookup: RepoLookup,
  request: GitRequest,
): GitResponse | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)?$/.exec(request.path);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  const tail = match[3] ?? '';
  const wantsV2 = (request.protocolHeader ?? '').includes('version=2');
  const serviceMatch = /^\/info\/refs$/.exec(tail);
  const service = request.query.get('service');
  if (serviceMatch) {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 400, contentType: 'text/plain', body: Buffer.from('bad service\n') };
    }
    const repo = lookup(owner, name);
    if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
    if (service === 'git-upload-pack' && wantsV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement(service) };
    }
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: v0Advertisement(repo, service) };
  }
  if (tail === '/git-upload-pack') {
    const repo = lookup(owner, name);
    if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
    return handleUploadPack(repo, request, wantsV2);
  }
  if (tail === '/git-receive-pack') {
    const repo = lookup(owner, name);
    if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
    return handleReceivePack(repo, request);
  }
  return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
}

function handleUploadPack(repo: Repository, request: GitRequest, wantsV2: boolean): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if (wantsV2) {
      const { command, args } = parseV2Request(request.body);
      if (command === 'ls-refs') return { status: 200, contentType, body: lsRefsResponse(repo, args) };
      if (command === 'fetch') return { status: 200, contentType, body: fetchV2Response(repo, request.body, args) };
      return { status: 200, contentType, body: Buffer.concat([dataPkt('ERR unknown command'), FLUSH_PKT]) };
    }
    return { status: 200, contentType, body: fetchV0Response(repo, request.body) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 200, contentType, body: Buffer.concat([dataPkt(`ERR ${message}`), FLUSH_PKT]) };
  }
}

function fetchV2Response(repo: Repository, body: Buffer, args: Map<string, string | true>): Buffer {
  const packets = parsePktLines(body);
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const spec = parseFetchArgs(args, haves);
  const { objects, shallow, unshallow } = selectFetchObjects(repo, spec);
  const sections: Buffer[] = [];
  const ackLines: string[] = [];
  if (spec.haves.length > 0 && objects.length > 0) ackLines.push('NAK');
  if (ackLines.length > 0) {
    const ack = Buffer.concat([dataPkt('acknowledgments\n'), ...ackLines.map((line) => dataPkt(line)), FLUSH_PKT]);
    sections.push(ack);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Buffer[] = [dataPkt('shallow-info\n')];
    for (const oid of shallow) lines.push(dataPkt(`shallow ${oid}\n`));
    for (const oid of unshallow) lines.push(dataPkt(`unshallow ${oid}\n`));
    lines.push(FLUSH_PKT);
    sections.push(Buffer.concat(lines));
  }
  const pack = writePack(objects);
  const packPackets = sideband(1, pack);
  sections.push(Buffer.concat([dataPkt('packfile\n'), packPackets, FLUSH_PKT]));
  return Buffer.concat(sections);
}

function fetchV0Response(repo: Repository, body: Buffer): Buffer {
  const spec = parseV0Fetch(body);
  const { objects, shallow, unshallow } = selectFetchObjects(repo, spec);
  const parts: Buffer[] = [dataPkt('NAK\n')];
  for (const oid of shallow) parts.push(dataPkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(dataPkt(`unshallow ${oid}\n`));
  const pack = writePack(objects);
  parts.push(sideband(1, pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function handleReceivePack(repo: Repository, request: GitRequest): GitResponse {
  const contentType = 'application/x-git-receive-pack-result';
  const packets = parsePktLines(request.body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities = '';
  let consumed = 0;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      consumed += 4;
      sawFlush = true;
      break;
    }
    if (packet.kind === 'delim') {
      consumed += 4;
      continue;
    }
    consumed += packet.payload.length + 4;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    let commandText = text;
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      commandText = text.slice(0, nul);
    }
    const space = commandText.indexOf(' ');
    const second = commandText.indexOf(' ', space + 1);
    if (space > 0 && second > 0) {
      commands.push({ oldOid: commandText.slice(0, space), newOid: commandText.slice(space + 1, second), ref: commandText.slice(second + 1) });
    }
  }
  void capabilities;
  let pack: Buffer | null = null;
  if (sawFlush && consumed < request.body.length) {
    pack = Buffer.from(request.body.subarray(consumed));
    if (pack.length < 12) pack = null;
  }
  const outcome = applyReceivePack(repo, commands, pack);
  const reportLines: string[] = [];
  reportLines.push(outcome.unpackOk ? 'unpack ok\n' : `unpack ${outcome.unpackDetail || 'failed'}\n`);
  for (const report of outcome.reports) {
    reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const reportBody = Buffer.concat(reportLines.map((line) => pktLine(line)).concat([FLUSH_PKT]));
  const wantsSideband = /side-band-64k/.test(capabilities);
  const body = wantsSideband
    ? Buffer.concat([sideband(1, reportBody), FLUSH_PKT])
    : reportBody;
  return { status: 200, contentType, body };
}
