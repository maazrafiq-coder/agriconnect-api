import { EventEmitter } from 'events';
import { AppLogger } from './app-logger';
import { requestIdMiddleware } from './request-id.middleware';
import { currentRequestId } from './request-context';

describe('logging', () => {
  let lines: string[];
  let outSpy: jest.SpyInstance, errSpy: jest.SpyInstance;
  beforeEach(() => {
    lines = [];
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => (lines.push(String(s)), true));
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((s: any) => (lines.push(String(s)), true));
    process.env.LOG_FORMAT = 'json';
    delete process.env.LOG_LEVEL;
  });
  afterEach(() => { outSpy.mockRestore(); errSpy.mockRestore(); delete process.env.LOG_FORMAT; delete process.env.LOG_LEVEL; });

  it('writes one JSON object per line', () => {
    new AppLogger().log('hello', 'Ctx');
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ level: 'log', context: 'Ctx', msg: 'hello' });
  });

  it('respects LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    const l = new AppLogger();
    l.log('quiet'); l.warn('loud');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('loud');
  });

  function run(headers: any, status = 200, url = '/api/v1/orders?token=SECRET') {
    const req: any = { headers, method: 'GET', originalUrl: url };
    const res: any = Object.assign(new EventEmitter(), { statusCode: status, setHeader: jest.fn() });
    let seen: string | undefined;
    requestIdMiddleware(req, res, () => { seen = currentRequestId(); });
    res.emit('finish');
    return { req, res, seen };
  }

  it('assigns a request id, exposes it, and binds it to the async context', () => {
    const { req, res, seen } = run({});
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(seen).toBe(req.id);
  });

  it('accepts a well-formed inbound id and rejects a malformed one', () => {
    expect(run({ 'x-request-id': 'abc12345-trace' }).req.id).toBe('abc12345-trace');
    expect(run({ 'x-request-id': 'bad id\nX: y' }).req.id).not.toContain('bad');
  });

  it('access log has the request id and never the query string', () => {
    const { req } = run({});
    const out = lines.join('');
    expect(out).toContain(req.id);
    expect(out).not.toContain('SECRET');
    expect(out).toContain('/api/v1/orders');
  });

  it('skips successful health probes but logs failing ones', () => {
    run({}, 200, '/api/v1/health/live');
    expect(lines).toHaveLength(0);
    run({}, 503, '/api/v1/health/ready');
    expect(lines).toHaveLength(1);
  });
});
