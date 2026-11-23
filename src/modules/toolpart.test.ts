import { expect, test } from "bun:test";
import { ToolPartBase, type PartShell } from "../webserver/public/js/core/toolpart";
import type { ToolHost } from "../webserver/public/js/core/dungeontoolparts";

// The request, refusal and problem handling the three tabs of the Dungeon Tool share (toolpart.ts), on a shell that
// writes down what it is asked to do.

type Call = [string, ...unknown[]];

function fakeShell(calls: Call[]): PartShell {
  const note = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  return {
    send: note("send"), waiting: note("waiting"), refused: note("refused"), arrived: note("arrived"), setProblems: note("setProblems"),
    setBanner: note("setBanner"), setRecord: note("setRecord"), setState: note("setState"), setActions: note("setActions"),
  } as unknown as PartShell;
}

class TestPart extends ToolPartBase {
  readonly kind = "things";
  protected readonly listPacket = "THING_EDITOR_LIST";
  protected requestWaitMs = 20;
  protected draft: { name: string } | null = null;
  log: Call[] = [];
  toasts: Array<[string, string | undefined]> = [];

  constructor(shell: PartShell, host: ToolHost) {
    super(shell, host, () => undefined);
    this.say = (text, tone) => void this.toasts.push([text, tone]);
  }

  protected adopt(data: any): void {
    this.log.push(["adopt", data]);
    this.landed();
  }
  protected onSaveResult(msg: any): void {
    this.log.push(["onSaveResult", msg]);
  }
  protected onDeleteResult(msg: any, name: string): void {
    this.log.push(["onDeleteResult", msg, name]);
  }
  protected renderList(): void {
    this.log.push(["renderList"]);
  }
  protected renderForm(): void {
    this.log.push(["renderForm"]);
  }
  protected chrome(): void {
    this.log.push(["chrome"]);
  }

  open(name: string): void {
    this.draft = { name };
    this.opened++;
  }
  request(kind: "save" | "delete", packet: string, name: string): void {
    this.beginRequest(kind, packet, { name }, name);
  }
  get state() {
    return { ready: this.ready, refusal: this.refusal, refused: this.refused, pending: this.pending, problems: this.problemLines(), key: this.pageKey() };
  }
  setFieldErrors(errors: Record<string, string>): void {
    this.fieldErrors = errors;
  }
}

function setup(kind = "things") {
  const calls: Call[] = [];
  const settled: Array<[string, boolean]> = [];
  const host: ToolHost = { kind, counted: () => undefined, settled: (k, ok) => void settled.push([k, ok]) };
  const part = new TestPart(fakeShell(calls), host);
  return { calls, settled, part, host };
}

const names = (calls: Call[]) => calls.map((c) => c[0]);
const blank = ["setBanner", "setRecord", "setState", "setActions"];

test("a tab not answered yet clears what the last tab drew, waits, and asks for its list again", () => {
  const { calls, part } = setup();
  part.activate();
  expect(names(calls)).toEqual([...blank, "waiting", "send"]);
  expect(calls[0]).toEqual(["setBanner", null]);
  expect(calls[1]).toEqual(["setRecord", null]);
  expect(calls[2]).toEqual(["setState", null]);
  expect(calls[3]).toEqual(["setActions", { open: false }]);
  expect(calls[5]).toEqual(["send", { type: "request", packet: "THING_EDITOR_LIST", data: null }]);
});

test("a refused tab clears what the last tab drew, says why, and Try again asks again", () => {
  const { calls, part } = setup();
  part.onMessage({ kind: "result", data: { ok: false, errors: ["You may not edit things."] } });
  expect(part.state.refusal).toEqual(["You may not edit things."]);
  expect(names(calls)).toEqual(["refused"]);
  calls.length = 0;
  part.activate();
  expect(names(calls)).toEqual([...blank, "refused"]);
  expect(calls[4]![1]).toEqual(["You may not edit things."]);
  calls.length = 0;
  (part as any).retry();
  expect(part.state.refusal).toBeNull();
  expect(calls).toEqual([["send", { type: "request", packet: "THING_EDITOR_LIST", data: null }]]);
});

test("a refusal while another tab is in view is kept for when this one is opened", () => {
  const { calls, part } = setup("others");
  part.onMessage({ kind: "result", data: { ok: false, errors: ["No."] } });
  expect(calls).toEqual([]);
  expect(part.state.refusal).toEqual(["No."]);
});

test("an answer that came is drawn at once on the tab in view", () => {
  const { calls, part } = setup();
  part.onMessage({ kind: "data", data: { things: [] } });
  expect(names(calls)).toEqual(["arrived"]);
  calls.length = 0;
  part.log.length = 0;
  part.activate();
  expect(names(calls)).toEqual(["arrived"]);
  expect(names(part.log)).toEqual(["renderList", "renderForm"]);
});

test("an answer to this tab's own request goes to its save or delete; another is adopted and reported", () => {
  const { calls, part } = setup();
  part.onMessage({ kind: "data", data: {} });
  part.request("save", "THING_EDITOR_SAVE", "Rock");
  expect(part.busy()).toBe(true);
  expect(calls.at(-1)).toEqual(["send", { type: "request", packet: "THING_EDITOR_SAVE", data: { name: "Rock" } }]);
  part.log.length = 0;
  // an answer to another request leaves this one waiting
  part.onMessage({ kind: "result", data: { ok: true, action: "THING_EDITOR_DELETE", data: { n: 1 } } });
  expect(part.busy()).toBe(true);
  expect(names(part.log)).toEqual(["adopt", "renderList", "renderForm"]);
  part.log.length = 0;
  part.onMessage({ kind: "result", data: { ok: true, action: "THING_EDITOR_SAVE", name: "Rock" } });
  expect(part.busy()).toBe(false);
  expect(names(part.log)).toEqual(["chrome", "onSaveResult", "renderList"]);

  part.request("delete", "THING_EDITOR_DELETE", "Rock");
  part.log.length = 0;
  part.onMessage({ kind: "result", data: { ok: true } });
  expect(part.log[1]).toEqual(["onDeleteResult", { ok: true }, "Rock"]);
});

test("a failure that is not this tab's goes on the form when one is open, else in a toast", () => {
  const { calls, part } = setup();
  part.onMessage({ kind: "data", data: {} });
  part.onMessage({ kind: "result", data: { ok: false } });
  expect(part.toasts).toEqual([["The server refused that.", "error"]]);
  part.open("Rock");
  calls.length = 0;
  part.onMessage({ kind: "result", data: { ok: false, errors: ["It broke."] } });
  expect(calls).toEqual([["setProblems", ["It broke."]]]);
});

test("a request the server does not answer in time ends, is marked, and the list is asked for again", async () => {
  const { calls, part, settled } = setup();
  part.onMessage({ kind: "data", data: {} });
  part.request("save", "THING_EDITOR_SAVE", "Rock");
  calls.length = 0;
  await Bun.sleep(40);
  expect(part.busy()).toBe(false);
  expect(part.state.refused).toBe(true);
  expect(part.toasts).toEqual([["The server did not answer in time, so nothing was confirmed.", "error"]]);
  expect(settled).toEqual([["things", false]]);
  expect(calls).toEqual([["send", { type: "request", packet: "THING_EDITOR_LIST", data: null }]]);

  // a delete that times out is not a failed save
  part.request("delete", "THING_EDITOR_DELETE", "Rock");
  (part as any).refused = false;
  await Bun.sleep(40);
  expect(part.state.refused).toBe(false);
  expect(settled.length).toBe(1);
});

test("an answer in time stops the clock", async () => {
  const { part } = setup();
  part.onMessage({ kind: "data", data: {} });
  part.request("save", "THING_EDITOR_SAVE", "Rock");
  part.onMessage({ kind: "result", data: { ok: true, action: "THING_EDITOR_SAVE" } });
  await Bun.sleep(40);
  expect(part.toasts).toEqual([]);
});

test("field problems are counted, and other problems shown as they are", () => {
  const { calls, part } = setup();
  part.setFieldErrors({ name: "x" });
  expect(part.state.problems).toEqual(["1 field needs fixing."]);
  part.setFieldErrors({ name: "x", size: "y" });
  expect(part.state.problems).toEqual(["2 fields need fixing."]);
  (part as any).clearProblems();
  expect(part.state.problems).toEqual([]);
  expect(calls.at(-1)).toEqual(["setProblems", []]);
});

test("a hidden tab does not touch the problems shown", () => {
  const { calls, part } = setup("others");
  (part as any).clearProblems();
  (part as any).showProblems(["x"]);
  expect(calls).toEqual([]);
});

test("each tab keeps its own scroll: the page key names the tab", () => {
  const a = setup().part;
  a.open("Rock");
  expect(a.state.key).toBe("things:1");
});
