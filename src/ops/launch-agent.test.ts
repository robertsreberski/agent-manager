import assert from "node:assert/strict";
import test from "node:test";

import {
  reloadLaunchAgent,
  stopLaunchAgent,
  type LaunchctlCommandResult,
  type LaunchctlRunner,
} from "./launch-agent.ts";

const UID = 501;
const LABEL = "local.agent-manager.cockpit";
const TARGET = `gui/${UID}/${LABEL}`;
const DOMAIN = `gui/${UID}`;
const DESTINATION = "/Users/test/Library/LaunchAgents/local.agent-manager.cockpit.plist";
const OK: LaunchctlCommandResult = { status: 0, stdout: "", stderr: "" };
const ABSENT_BOOTOUT: LaunchctlCommandResult = {
  status: 3,
  stdout: "",
  stderr: "Boot-out failed: 3: No such process\n",
};
const ABSENT_PRINT: LaunchctlCommandResult = {
  status: 113,
  stdout: "",
  stderr: `Bad request.\nCould not find service "${LABEL}" in domain for user gui: ${UID}\n`,
};
const TRANSIENT_BOOTSTRAP: LaunchctlCommandResult = {
  status: 5,
  stdout: "",
  stderr: "Bootstrap failed: 5: Input/output error\n",
};

interface ExpectedCall {
  args: string[];
  result: LaunchctlCommandResult;
}

function fixtureRunner(expected: ExpectedCall[]): LaunchctlRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(args) {
      const call = [...args];
      calls.push(call);
      const next = expected.shift();
      assert.ok(next, `unexpected launchctl call: ${call.join(" ")}`);
      assert.deepEqual(call, next.args);
      return next.result;
    },
  };
}

function reloadWith(
  expected: ExpectedCall[],
  pauses: number[] = [],
): LaunchctlRunner & { calls: string[][] } {
  const runner = fixtureRunner(expected);
  reloadLaunchAgent(DESTINATION, LABEL, UID, {
    runner,
    sleep: (milliseconds) => pauses.push(milliseconds),
  });
  assert.equal(expected.length, 0, "all expected launchctl calls must be consumed");
  return runner;
}

test("stops only the exact Agent Manager per-user target and accepts absence", () => {
  const expected: ExpectedCall[] = [
    { args: ["bootout", TARGET], result: ABSENT_BOOTOUT },
    { args: ["print", TARGET], result: ABSENT_PRINT },
  ];
  const runner = fixtureRunner(expected);
  stopLaunchAgent(UID, { runner, sleep: () => {} });
  assert.equal(expected.length, 0);
  assert.deepEqual(runner.calls, [
    ["bootout", "gui/501/local.agent-manager.cockpit"],
    ["print", "gui/501/local.agent-manager.cockpit"],
  ]);
});

test("reloads an absent LaunchAgent using only the exact per-user target", () => {
  const runner = reloadWith([
    { args: ["bootout", TARGET], result: ABSENT_BOOTOUT },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: OK },
    { args: ["kickstart", "-k", TARGET], result: OK },
  ]);

  assert.deepEqual(runner.calls.at(-1), ["kickstart", "-k", TARGET]);
});

test("waits for the exact old job to disappear before bootstrapping", () => {
  const pauses: number[] = [];
  reloadWith([
    { args: ["bootout", TARGET], result: OK },
    { args: ["print", TARGET], result: OK },
    { args: ["print", TARGET], result: OK },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: OK },
    { args: ["kickstart", "-k", TARGET], result: OK },
  ], pauses);

  assert.deepEqual(pauses, [50, 50]);
});

test("allows a normal launchd teardown to take longer than one second", () => {
  let printChecks = 0;
  const pauses: number[] = [];
  const calls: string[][] = [];
  const runner: LaunchctlRunner = {
    run(args) {
      const call = [...args];
      calls.push(call);
      if (call[0] === "bootout") return OK;
      if (call[0] === "print") {
        printChecks += 1;
        return printChecks < 25 ? OK : ABSENT_PRINT;
      }
      if (call[0] === "bootstrap" || call[0] === "kickstart") return OK;
      assert.fail(`unexpected launchctl call: ${call.join(" ")}`);
    },
  };

  reloadLaunchAgent(DESTINATION, LABEL, UID, {
    runner,
    sleep: (milliseconds) => pauses.push(milliseconds),
  });

  assert.equal(printChecks, 25);
  assert.equal(pauses.length, 24);
  assert.equal(pauses.reduce((total, milliseconds) => total + milliseconds, 0), 1_200);
  assert.deepEqual(calls.at(-2), ["bootstrap", DOMAIN, DESTINATION]);
  assert.deepEqual(calls.at(-1), ["kickstart", "-k", TARGET]);
});

test("retries only the transient bootstrap handoff race", () => {
  const pauses: number[] = [];
  reloadWith([
    { args: ["bootout", TARGET], result: OK },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: TRANSIENT_BOOTSTRAP },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: OK },
    { args: ["kickstart", "-k", TARGET], result: OK },
  ], pauses);

  assert.deepEqual(pauses, [100]);
});

test("accepts a bootstrap error only when the exact job was registered", () => {
  reloadWith([
    { args: ["bootout", TARGET], result: OK },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: TRANSIENT_BOOTSTRAP },
    { args: ["print", TARGET], result: OK },
    { args: ["kickstart", "-k", TARGET], result: OK },
  ]);
});

test("does not retry malformed plists or arbitrary bootstrap failures", () => {
  const expected: ExpectedCall[] = [
    { args: ["bootout", TARGET], result: ABSENT_BOOTOUT },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    {
      args: ["bootstrap", DOMAIN, DESTINATION],
      result: { status: 78, stdout: "", stderr: "Invalid property list\n" },
    },
  ];
  const runner = fixtureRunner(expected);
  const pauses: number[] = [];

  assert.throws(
    () => reloadLaunchAgent(DESTINATION, LABEL, UID, {
      runner,
      sleep: (milliseconds) => pauses.push(milliseconds),
    }),
    /launchctl bootstrap failed: Invalid property list/u,
  );
  assert.equal(expected.length, 0);
  assert.deepEqual(pauses, []);
});

test("bounds repeated error-5 bootstrap retries and surfaces the failure", () => {
  const expected: ExpectedCall[] = [
    { args: ["bootout", TARGET], result: OK },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: TRANSIENT_BOOTSTRAP },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: TRANSIENT_BOOTSTRAP },
    { args: ["print", TARGET], result: ABSENT_PRINT },
    { args: ["bootstrap", DOMAIN, DESTINATION], result: TRANSIENT_BOOTSTRAP },
    { args: ["print", TARGET], result: ABSENT_PRINT },
  ];
  const runner = fixtureRunner(expected);
  const pauses: number[] = [];

  assert.throws(
    () => reloadLaunchAgent(DESTINATION, LABEL, UID, {
      runner,
      sleep: (milliseconds) => pauses.push(milliseconds),
    }),
    /launchctl bootstrap failed after 3 attempts: Bootstrap failed: 5: Input\/output error/u,
  );
  assert.equal(expected.length, 0);
  assert.deepEqual(pauses, [100, 100]);
});

test("does not hide an arbitrary bootout failure", () => {
  const expected: ExpectedCall[] = [{
    args: ["bootout", TARGET],
    result: { status: 1, stdout: "", stderr: "Boot-out denied\n" },
  }];
  const runner = fixtureRunner(expected);

  assert.throws(
    () => reloadLaunchAgent(DESTINATION, LABEL, UID, { runner, sleep: () => {} }),
    /launchctl bootout failed: Boot-out denied/u,
  );
  assert.equal(expected.length, 0);
});
