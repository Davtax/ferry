// End-to-end test of the sync engine against an in-process SFTP server.
// Run with: npm run compile && node test/integration.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { Server, utils } = require('ssh2');

// ------------------------------------------------------------------ minimal vscode stub
const settings = { compareMode: 'content', concurrency: 4, maxContentCompareSize: 1e7, defaultIgnore: ['.vscode/', '.ferryignore', '*.pyc'], respectGitignore: false };
class EventEmitter {
  constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; }
  fire(v) { this.l.forEach((f) => f(v)); }
  dispose() {}
}
const memento = new Map();
class FileSystemError extends Error {
  constructor(m, code) { super(m); this.code = code; }
  static FileNotFound(u) { return new FileSystemError(`not found: ${u?.path ?? u}`, 'FileNotFound'); }
  static FileExists(u) { return new FileSystemError(`exists: ${u?.path ?? u}`, 'FileExists'); }
  static FileIsADirectory(u) { return new FileSystemError(`is a directory: ${u?.path ?? u}`, 'FileIsADirectory'); }
  static Unavailable(m) { return new FileSystemError(m, 'Unavailable'); }
}
const vscodeStub = {
  EventEmitter,
  FileSystemError,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  Disposable: class { constructor(f) { this.dispose = f; } },
  ViewColumn: { Active: -1 },
  RelativePattern: class {},
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }), from: (o) => o },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    fs: { delete: async (uri) => fs.promises.unlink(uri.fsPath) },
  },
  window: { showInputBox: async () => { throw new Error('unexpected prompt'); } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

// ------------------------------------------------------------------ in-process SFTP server
const { STATUS_CODE, flagsToString } = utils.sftp;
const throttle = { ms: 0, n: 0 }; // simulated slow network: delay every 16th WRITE

function startServer(rootDir) {
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => serveSftp(acceptSftp(), rootDir))));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function serveSftp(sftp, root) {
  const real = (p) => path.join(root, path.posix.normalize('/' + p));
  const handles = new Map();
  let nextHandle = 0;
  const newHandle = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(nextHandle++); handles.set(b.toString('hex'), v); return b; };
  const toAttrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
  const fail = (id, err) => sftp.status(id, err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err.message);

  sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.normalize('/' + p), longname: '', attrs: {} }]));
  const stat = (id, p) => fs.stat(real(p), (e, st) => (e ? fail(id, e) : sftp.attrs(id, toAttrs(st))));
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);
  sftp.on('FSTAT', (id, h) => fs.fstat(handles.get(h.toString('hex')).fd, (e, st) => (e ? fail(id, e) : sftp.attrs(id, toAttrs(st)))));
  sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
  sftp.on('OPEN', (id, p, flags) => {
    fs.open(real(p), flagsToString(flags), (e, fd) => (e ? fail(id, e) : sftp.handle(id, newHandle({ fd }))));
  });
  sftp.on('READ', (id, h, offset, len) => {
    const v = handles.get(h.toString('hex'));
    if (!v) return sftp.status(id, STATUS_CODE.FAILURE, 'closed handle');
    const buf = Buffer.alloc(len);
    fs.read(v.fd, buf, 0, len, offset, (e, n) => {
      if (e) return fail(id, e);
      if (n === 0) return sftp.status(id, STATUS_CODE.EOF);
      sftp.data(id, buf.subarray(0, n));
    });
  });
  sftp.on('WRITE', (id, h, offset, data) => {
    const v = handles.get(h.toString('hex'));
    if (!v) return sftp.status(id, STATUS_CODE.FAILURE, 'closed handle');
    fs.write(v.fd, data, 0, data.length, offset, (e) =>
    {
      const reply = () => (e ? fail(id, e) : sftp.status(id, STATUS_CODE.OK));
      if (throttle.ms && ++throttle.n % 16 === 0) setTimeout(reply, throttle.ms);
      else reply();
    });
  });
  sftp.on('CLOSE', (id, h) => {
    const key = h.toString('hex');
    const v = handles.get(key);
    handles.delete(key);
    if (v && v.fd !== undefined) fs.close(v.fd, () => sftp.status(id, STATUS_CODE.OK));
    else sftp.status(id, STATUS_CODE.OK);
  });
  sftp.on('OPENDIR', (id, p) => {
    fs.readdir(real(p), (e, names) => (e ? fail(id, e) : sftp.handle(id, newHandle({ dir: real(p), names, sent: false }))));
  });
  sftp.on('READDIR', (id, h) => {
    const v = handles.get(h.toString('hex'));
    if (v.sent) return sftp.status(id, STATUS_CODE.EOF);
    v.sent = true;
    sftp.name(id, v.names.map((n) => {
      const st = fs.statSync(path.join(v.dir, n));
      return { filename: n, longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 u g ${st.size} Jan 1 00:00 ${n}`, attrs: toAttrs(st) };
    }));
  });
  sftp.on('MKDIR', (id, p) => fs.mkdir(real(p), (e) => (e ? fail(id, e) : sftp.status(id, STATUS_CODE.OK))));
  sftp.on('REMOVE', (id, p) => fs.unlink(real(p), (e) => (e ? fail(id, e) : sftp.status(id, STATUS_CODE.OK))));
  sftp.on('RMDIR', (id, p) => fs.rmdir(real(p), (e) => (e ? fail(id, e) : sftp.status(id, STATUS_CODE.OK))));
  sftp.on('RENAME', (id, from, to) => fs.rename(real(from), real(to), (e) => (e ? fail(id, e) : sftp.status(id, STATUS_CODE.OK))));
}

// ------------------------------------------------------------------ test
const write = (file, text, mtimeSec) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
};
const progress = { report() {} };
function tokenSource() {
  const listeners = [];
  const token = { isCancellationRequested: false, onCancellationRequested: (f) => { listeners.push(f); return { dispose() {} }; } };
  return { token, cancel() { token.isCancellationRequested = true; listeners.forEach((f) => f()); } };
}
const token = tokenSource().token;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-test-'));
  const local = path.join(tmp, 'local');
  const remoteRoot = path.join(tmp, 'remote');
  const remoteProject = path.join(remoteRoot, 'srv', 'app');
  const server = await startServer(remoteRoot);
  const port = server.address().port;

  write(path.join(local, '.vscode', 'ferry.json'), JSON.stringify({
    defaultServer: 'test',
    servers: [{ name: 'test', host: '127.0.0.1', port, username: 'u', password: 'secret', remotePath: '/srv/app', ignore: ['secrets/'] }],
  }));
  write(path.join(local, '.ferryignore'), '*.log\n');
  const old = 1_600_000_000;
  const recent = 1_700_000_000;
  write(path.join(local, 'same.txt'), 'identical', old);
  write(path.join(remoteProject, 'same.txt'), 'identical', old);
  write(path.join(local, 'pkg', 'newer_local.py'), 'print(2)', recent);
  write(path.join(remoteProject, 'pkg', 'newer_local.py'), 'print(1)', old);
  write(path.join(local, 'newer_remote.txt'), 'aaa', old);
  write(path.join(remoteProject, 'newer_remote.txt'), 'bbbbbb', recent);
  write(path.join(local, 'only_local.txt'), 'L');
  write(path.join(remoteProject, 'deep', 'only_remote.txt'), 'R');
  for (const f of ['gone_local.txt', 'gone_local_edited.txt']) {
    write(path.join(local, f), 'synced', old);
    write(path.join(remoteProject, f), 'synced', old);
  }
  write(path.join(local, 'debug.log'), 'ignored by .ferryignore');
  write(path.join(local, 'secrets', 'key.pem'), 'ignored by server ignore');
  write(path.join(local, 'x.pyc'), 'ignored by default');
  write(path.join(remoteProject, 'remote.log'), 'ignored');

  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: local }, name: 'local' }];
  const { ConfigManager } = require('../out/config');
  const { ConnectionManager } = require('../out/connection');
  const { IgnoreManager } = require('../out/ignore');
  const { RemoteContentProvider } = require('../out/remoteContent');
  const { SyncEngine } = require('../out/sync');
  const config = new ConfigManager();
  const conns = new ConnectionManager({ get: async () => undefined, store: async () => {}, delete: async () => {} });
  const ignores = new IgnoreManager(config);
  const remote = new RemoteContentProvider(config, conns);
  const engine = new SyncEngine(config, conns, ignores, remote, { get: (k, d) => memento.get(k) ?? d, update: async (k, v) => memento.set(k, v) });
  const srv = config.activeServer;

  try {
    // 1. First compare: no sync history.
    let { entries, identical } = await engine.compare(srv, '', progress, token);
    const byRel = Object.fromEntries(entries.map((e) => [e.rel, e]));
    console.log('first compare:', entries.map((e) => `${e.rel}:${e.status}:${e.action}`).join(', '), `| identical=${identical}`);
    assert.deepStrictEqual(Object.keys(byRel).sort(), ['deep/only_remote.txt', 'newer_remote.txt', 'only_local.txt', 'pkg/newer_local.py']);
    assert.strictEqual(identical, 3);
    assert.strictEqual(byRel['pkg/newer_local.py'].action, 'upload');
    assert.strictEqual(byRel['newer_remote.txt'].action, 'download');
    assert.strictEqual(byRel['only_local.txt'].action, 'upload');
    assert.strictEqual(byRel['deep/only_remote.txt'].action, 'download');

    // Remote content for diffs was cached / can be fetched.
    const txt = await remote.provideTextDocumentContent({ path: '/srv/app/newer_remote.txt', query: 'server=test' });
    assert.strictEqual(txt, 'bbbbbb');

    // 2. Apply suggested actions.
    const res = await engine.apply(srv, entries, progress, token);
    assert.strictEqual(res.failed.length, 0, JSON.stringify(res.failed));
    assert.strictEqual(fs.readFileSync(path.join(remoteProject, 'pkg', 'newer_local.py'), 'utf8'), 'print(2)');
    assert.strictEqual(fs.readFileSync(path.join(local, 'newer_remote.txt'), 'utf8'), 'bbbbbb');
    assert.ok(fs.existsSync(path.join(remoteProject, 'only_local.txt')));
    assert.ok(fs.existsSync(path.join(local, 'deep', 'only_remote.txt')));
    assert.ok(!fs.existsSync(path.join(remoteProject, 'debug.log')), 'ignored file must not be uploaded');
    assert.ok(!fs.existsSync(path.join(remoteProject, 'secrets')), 'server-ignored dir must not be uploaded');

    // 3. Everything is in sync now.
    ({ entries, identical } = await engine.compare(srv, '', progress, token));
    assert.deepStrictEqual(entries, []);
    console.log('after apply: in sync, identical =', identical);

    // 4. Change each side once -> direction comes from sync history, even against mtimes.
    write(path.join(local, 'same.txt'), 'local edit!', old - 100);
    write(path.join(remoteProject, 'only_local.txt'), 'remote edit', old - 100);
    write(path.join(local, 'pkg', 'newer_local.py'), 'print(3)!');
    write(path.join(remoteProject, 'pkg', 'newer_local.py'), 'print(4)?');
    fs.unlinkSync(path.join(remoteProject, 'newer_remote.txt'));
    fs.unlinkSync(path.join(local, 'gone_local.txt'));
    fs.unlinkSync(path.join(local, 'gone_local_edited.txt'));
    write(path.join(remoteProject, 'gone_local_edited.txt'), 'edited on the server');
    ({ entries } = await engine.compare(srv, '', progress, token));
    const after = Object.fromEntries(entries.map((e) => [e.rel, e]));
    console.log('after edits:', entries.map((e) => `${e.rel}:${e.status}:${e.action}`).join(', '));
    assert.strictEqual(after['same.txt'].action, 'upload');
    assert.strictEqual(after['only_local.txt'].action, 'download');
    assert.strictEqual(after['pkg/newer_local.py'].status, 'conflict');
    assert.strictEqual(after['pkg/newer_local.py'].action, 'skip');
    assert.strictEqual(after['newer_remote.txt'].status, 'localOnly');
    assert.strictEqual(after['newer_remote.txt'].action, 'skip', 'remote deletion is not undone by default');
    assert.strictEqual(after['gone_local.txt'].status, 'remoteOnly');
    assert.strictEqual(after['gone_local.txt'].action, 'deleteRemote', 'local deletion is carried over to the server');
    assert.strictEqual(after['gone_local_edited.txt'].action, 'skip', 'no remote delete when the server copy changed');
    await engine.apply(srv, [after['gone_local.txt']], progress, token);
    assert.ok(!fs.existsSync(path.join(remoteProject, 'gone_local.txt')));

    // 5. Scoped compare and delete actions.
    ({ entries } = await engine.compare(srv, 'pkg', progress, token));
    assert.deepStrictEqual(entries.map((e) => e.rel), ['pkg/newer_local.py']);
    after['newer_remote.txt'].action = 'deleteLocal';
    await engine.apply(srv, [after['newer_remote.txt']], progress, token);
    assert.ok(!fs.existsSync(path.join(local, 'newer_remote.txt')));

    // 6. Upload-on-save safety check.
    assert.strictEqual(await engine.remoteUnchangedSinceSync(srv, 'deep/only_remote.txt'), true);
    write(path.join(remoteProject, 'deep', 'only_remote.txt'), 'changed remotely');
    assert.strictEqual(await engine.remoteUnchangedSinceSync(srv, 'deep/only_remote.txt'), false);

    // 7. Parallel uploads into new folders sharing new parents (mkdir race).
    settings.concurrency = 8;
    const fresh = [];
    for (const d of ['gen/a', 'gen/b', 'gen/a/x', 'gen/c/y/z']) {
      for (let i = 0; i < 4; i++) {
        write(path.join(local, ...d.split('/'), `f${i}.txt`), `${d}/${i}`);
        fresh.push(`${d}/f${i}.txt`);
      }
    }
    const raceRes = await engine.apply(srv, fresh.map((rel) => ({ rel, status: 'localOnly', action: 'upload', suggested: 'upload', note: '' })), progress, token);
    assert.deepStrictEqual(raceRes.failed, [], 'no mkdir race failures');
    fresh.forEach((rel) => assert.ok(fs.existsSync(path.join(remoteProject, ...rel.split('/'))), rel));
    console.log(`parallel upload into new folders: ${raceRes.done.length} ok`);

    // 8. Byte-level progress with speed and ETA on a large file.
    settings.concurrency = 4;
    const bigLocal = path.join(local, 'big', 'blob.bin');
    fs.mkdirSync(path.dirname(bigLocal), { recursive: true });
    fs.writeFileSync(bigLocal, crypto.randomBytes(64 * 1024 * 1024));
    const reports = [];
    const t0 = Date.now();
    throttle.ms = 20;
    const bigRes = await engine.apply(srv, [{ rel: 'big/blob.bin', status: 'localOnly', action: 'upload', suggested: 'upload', note: '' }],
      { report: (r) => reports.push(r) }, token);
    throttle.ms = 20;
    assert.deepStrictEqual(bigRes.failed, []);
    assert.strictEqual(fs.statSync(path.join(remoteProject, 'big', 'blob.bin')).size, 64 * 1024 * 1024);
    const total = reports.reduce((a, r) => a + (r.increment || 0), 0);
    assert.ok(Math.abs(total - 100) < 0.01, `increments sum to ${total}`);
    assert.ok(reports.length > 3, 'progress reported during the transfer, not only at the end');
    const withEta = reports.filter((r) => /MB\/s · ~\S+ left/.test(r.message));
    assert.ok(withEta.length > 0, 'speed and remaining time shown');
    console.log(`64 MB upload in ${Date.now() - t0} ms, ${reports.length} reports, e.g. "${(withEta[0] || reports[reports.length - 2]).message}"`);

    // 9. Cancelling a running download keeps the old local file and leaves no .ferry-part.
    fs.writeFileSync(bigLocal, 'old local content');
    const src = tokenSource();
    const cr = await engine.apply(srv, [{ rel: 'big/blob.bin', status: 'modified', action: 'download', suggested: 'download', note: '' }],
      { report: (r) => { if (parseFloat(r.message) >= 1 && !src.token.isCancellationRequested) src.cancel(); } }, src.token);
    assert.strictEqual(cr.failed.length, 1, 'cancelled download reported as failed');
    assert.strictEqual(fs.readFileSync(bigLocal, 'utf8'), 'old local content');
    assert.ok(!fs.existsSync(bigLocal + '.ferry-part'), 'temp file removed');
    console.log('cancelled download:', cr.failed[0].error);

    // 10. A full download replaces the file only once complete.
    const dl = await engine.apply(srv, [{ rel: 'big/blob.bin', status: 'modified', action: 'download', suggested: 'download', note: '' }], progress, token);
    assert.deepStrictEqual(dl.failed, []);
    assert.strictEqual(fs.statSync(bigLocal).size, 64 * 1024 * 1024);

    // 11. Server form: test login, detect home, browse remote folders and create one.
    const { ServerForm } = require('../out/serverForm');
    const posted = [];
    let receive;
    vscodeStub.window.createWebviewPanel = () => ({
      webview: { html: '', postMessage: async (m) => posted.push(m), onDidReceiveMessage: (f) => (receive = f) },
      onDidDispose() {},
      reveal() {},
      dispose() {},
    });
    const { ProfileStore } = require('../out/profiles');
    const store = new Map();
    const profiles = new ProfileStore({ get: (k) => store.get(k), update: async (k, v) => store.set(k, v) });
    vscodeStub.window.setStatusBarMessage = () => {};
    ServerForm.show(config, conns, profiles, { saved: async () => {} });
    const ask = async (msg, type) => {
      const from = posted.length;
      receive(msg);
      for (let i = 0; i < 200; i++) {
        const hit = posted.slice(from).find((m) => m.type === type || m.kind === type);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${type} reply to ${msg.type}: ${JSON.stringify(posted.slice(from))}`);
    };
    const form = { name: 'f', host: '127.0.0.1', port: String(port), username: 'u', auth: 'password', password: 'secret', savePassword: false,
      privateKeyPath: '', passphrase: '', agentSocket: '', remotePath: '/srv', localPath: '', makeDefault: false };
    assert.match((await ask({ type: 'test', data: form }, 'ok')).text, /successful/);
    assert.match((await ask({ type: 'test', data: { ...form, password: 'wrong' } }, 'error')).text, /Connection failed/);
    assert.deepStrictEqual(await ask({ type: 'detectHome', data: form }, 'set'), { type: 'set', field: 'remotePath', value: '/' });
    const listing = await ask({ type: 'browse', data: form }, 'browseShow');
    assert.strictEqual(listing.path, '/srv');
    assert.deepStrictEqual(listing.dirs, ['app']);
    const made = await ask({ type: 'browseMkdir', data: form, path: '/srv', name: 'new_proj' }, 'browseShow');
    assert.strictEqual(made.path, '/srv/new_proj');
    assert.ok(fs.statSync(path.join(remoteRoot, 'srv', 'new_proj')).isDirectory());
    assert.match((await ask({ type: 'browseMkdir', data: form, path: '/srv', name: 'new_proj' }, 'browseError')).text, /already exists/);
    const missing = await ask({ type: 'browse', data: form, path: '/nope' }, 'browseShow');
    assert.strictEqual(missing.path, '/');
    assert.match(missing.note, /does not exist/);
    receive({ type: 'browseClose' });
    console.log('server form: test, detect home, browse and mkdir ok');

    // 12. Saving remembers the server on this machine; ferry.json gets no key path; a saved server can be reloaded.
    receive({ type: 'save', data: { ...form, name: 'saved1', remotePath: '/srv/new_proj' } });
    for (let i = 0; i < 200 && !config.getServer('saved1'); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    const savedCfg = config.getServer('saved1');
    assert.ok(savedCfg, 'server written to ferry.json');
    assert.strictEqual(savedCfg.auth, 'password');
    assert.strictEqual(savedCfg.privateKeyPath, undefined);
    const prof = profiles.get(savedCfg);
    assert.strictEqual(prof.remotePath, '/srv/new_proj');
    assert.strictEqual(prof.username, 'u');
    ServerForm.show(config, conns, profiles, { saved: async () => {} });
    const applied = await ask({ type: 'pickProfile', id: `u@127.0.0.1:${port}` }, 'applyProfile');
    assert.strictEqual(applied.data.remotePath, '/srv/new_proj');
    assert.strictEqual(applied.data.name, 'saved1 (2)', 'name made unique in this project');

    // 13. Key path: the path saved on this machine wins over ferry.json; missing files fall through.
    const keyFile = path.join(tmp, 'machine_key');
    fs.writeFileSync(keyFile, 'dummy');
    const keyServer = { name: 'k', host: 'h', port: 22, username: 'ku', auth: 'key', privateKeyPath: path.join(tmp, 'missing_key'), remotePath: '/' };
    const conns2 = new ConnectionManager({ get: async () => undefined, store: async () => {}, delete: async () => {} }, profiles);
    await profiles.setKeyPath(keyServer, keyFile);
    assert.strictEqual(await conns2.resolveKeyPath(keyServer, false), keyFile);
    await profiles.remove(keyServer);
    assert.strictEqual(await conns2.resolveKeyPath({ ...keyServer, privateKeyPath: keyFile }, false), keyFile);
    console.log('saved servers and per-machine key paths ok');

    // 14. Editable remote files: create, read, overwrite, list, rename, delete.
    const { RemoteFileSystem } = require('../out/remoteFs');
    const rfs = new RemoteFileSystem(config, conns);
    const writes = [];
    rfs.onDidWrite = (_s, abs, added) => writes.push([abs, added]);
    const ru = (p) => RemoteFileSystem.uri('test', p);
    const code = async (p) => p.then(() => 'ok', (e) => e.code);
    await rfs.writeFile(ru('/srv/app/edit.txt'), Buffer.from('v1'), { create: true, overwrite: true });
    assert.strictEqual(Buffer.from(await rfs.readFile(ru('/srv/app/edit.txt'))).toString(), 'v1');
    await rfs.writeFile(ru('/srv/app/edit.txt'), Buffer.from('version 2'), { create: false, overwrite: true });
    assert.strictEqual(fs.readFileSync(path.join(remoteProject, 'edit.txt'), 'utf8'), 'version 2');
    const st = await rfs.stat(ru('/srv/app/edit.txt'));
    assert.strictEqual(st.type, 1);
    assert.strictEqual(st.size, 9);
    assert.ok(st.mtime > 0);
    assert.strictEqual((await rfs.stat(ru('/srv/app'))).type, 2);
    assert.strictEqual(await code(rfs.writeFile(ru('/srv/app/edit.txt'), Buffer.from('x'), { create: true, overwrite: false })), 'FileExists');
    assert.strictEqual(await code(rfs.writeFile(ru('/srv/app/nope.txt'), Buffer.from('x'), { create: false, overwrite: true })), 'FileNotFound');
    assert.strictEqual(await code(rfs.readFile(ru('/srv/app/nope.txt'))), 'FileNotFound');
    assert.strictEqual(await code(rfs.stat(ru('/srv/app/nope.txt'))), 'FileNotFound');
    assert.ok((await rfs.readDirectory(ru('/srv/app'))).some(([n, t]) => n === 'edit.txt' && t === 1));
    await rfs.createDirectory(ru('/srv/app/newdir'));
    await rfs.rename(ru('/srv/app/edit.txt'), ru('/srv/app/newdir/moved.txt'), { overwrite: false });
    assert.ok(fs.existsSync(path.join(remoteProject, 'newdir', 'moved.txt')));
    await rfs.delete(ru('/srv/app/newdir'), { recursive: true });
    assert.ok(!fs.existsSync(path.join(remoteProject, 'newdir')));
    assert.deepStrictEqual(writes.slice(0, 2), [['/srv/app/edit.txt', true], ['/srv/app/edit.txt', false]]);
    console.log('remote file system: edit, list, rename, delete ok');

    // 15. Ignoring line endings / whitespace when comparing.
    const wsFiles = {
      'crlf.txt': ['a\r\nb\r\n', 'a\nb\n'],
      'trailing.txt': ['a  \nb\n\n\n', 'a\nb'],
      'indent.py': ['if x:\n\tpass\n', 'if x:\n    pass\n'],
      'real.txt': ['hello world\n', 'hello there\n'],
      'bin.dat': [Buffer.from([0, 1, 13, 10]), Buffer.from([0, 1, 10])],
    };
    for (const [name, [l, r]] of Object.entries(wsFiles)) {
      write(path.join(local, 'ws', name), l, old);
      write(path.join(remoteProject, 'ws', name), r, old);
    }
    const differing = async (ignoreLineEndings, ignoreWhitespace) => {
      Object.assign(settings, { ignoreLineEndings, ignoreWhitespace });
      memento.clear(); // no sync history, so every pair is compared afresh
      const res = await engine.compare(srv, 'ws', progress, token);
      return { diff: res.entries.map((e) => path.posix.basename(e.rel)).sort(), ignored: res.ignoredDiffs };
    };
    assert.deepStrictEqual((await differing(false, 'off')).diff, ['bin.dat', 'crlf.txt', 'indent.py', 'real.txt', 'trailing.txt']);
    assert.deepStrictEqual(await differing(true, 'off'), { diff: ['bin.dat', 'indent.py', 'real.txt', 'trailing.txt'], ignored: 1 });
    assert.deepStrictEqual(await differing(false, 'trailing'), { diff: ['bin.dat', 'crlf.txt', 'indent.py', 'real.txt'], ignored: 1 });
    // Tab vs 4 spaces is a change in the amount of whitespace, so "amount" ignores it…
    assert.deepStrictEqual(await differing(true, 'amount'), { diff: ['bin.dat', 'real.txt'], ignored: 3 });
    // …but removing the indentation altogether is still a difference.
    write(path.join(local, 'ws', 'indent.py'), 'if x:\npass\n', old);
    assert.deepStrictEqual(await differing(true, 'amount'), { diff: ['bin.dat', 'indent.py', 'real.txt'], ignored: 2 });
    Object.assign(settings, { ignoreLineEndings: false, ignoreWhitespace: 'off' });
    console.log('ignore line endings / whitespace ok');


    console.log('\nAll integration checks passed.');
  } finally {
    await conns.closeAll();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
