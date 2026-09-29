import Foundation
import XCTest
@testable import LobstahPetCore

final class RunCommandTests: XCTestCase {
  private let sh = "/bin/sh"

  func testReturnsAllOfOutputLargerThanThePipe() {
    // About 230 KB: more than three times what a pipe holds. Numbered
    // lines also check that nothing is lost or out of order.
    let expected = (1...40_000).map { "\($0)\n" }.joined()
    XCTAssertGreaterThan(expected.utf8.count, 200 * 1024)
    let out = runCommand(sh, ["-c", "seq 1 40000"], timeout: 10)
    XCTAssertEqual(out?.count, expected.count)
    XCTAssertTrue(out == expected)
  }

  func testTimeoutTerminatesTheChildAndReturnsNil() {
    let started = Date()
    let result = execute(sh, ["-c", "sleep 30"], timeout: 0.5)
    XCTAssertEqual(result.outcome, .timedOut)
    XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    XCTAssertGreaterThan(result.pid, 0)
    // kill(pid, 0) fails with ESRCH once the child is gone and reaped.
    XCTAssertEqual(kill(result.pid, 0), -1)
    XCTAssertEqual(errno, ESRCH)
    XCTAssertNil(runCommand(sh, ["-c", "sleep 30"], timeout: 0.5))
  }

  func testTimeoutKillsAChildThatIgnoresSigterm() {
    let result = execute(sh, ["-c", "trap '' TERM; exec sleep 30"], timeout: 0.5)
    XCTAssertEqual(result.outcome, .timedOut)
    XCTAssertEqual(kill(result.pid, 0), -1)
  }

  func testLargeStandardErrorDoesNotBlockStandardOutput() {
    let out = runCommand(sh, ["-c", "head -c 204800 /dev/zero >&2; printf ok"], timeout: 10)
    XCTAssertEqual(out, "ok")
  }

  func testNonZeroExitReturnsNilAndItsStatus() {
    XCTAssertNil(runCommand(sh, ["-c", "printf partial; exit 2"]))
    XCTAssertEqual(execute(sh, ["-c", "printf partial; exit 2"]).outcome, .exited(status: 2, stdout: Data("partial".utf8)))
  }

  func testLaunchFailure() {
    guard case .launchFailed = execute("/nonexistent/lobstah", []).outcome else {
      return XCTFail("expected a launch failure")
    }
  }
}

final class ReadAttentionTests: XCTestCase {
  private let narrow = #"{"attention":[{"id":"a","verb":"needs-decision","note":"which?","key":"work:a","kind":"question"},{"id":"b","verb":"done","note":null,"key":"pr:o/r#1","kind":"pr:ready","prUrl":"https://github.com/o/r/pull/1","acked":{"at":"2026-09-29T00:00:00Z","by":"pet"}}]}"#
  private let tend = #"{"verdict":"needs-attention","stories":[],"attention":[{"id":"a","verb":"needs-decision","note":"which?","key":"work:a","kind":"question"}]}"#

  func testNarrowCommandFirstAndAcknowledgedItemsSkipped() {
    var calls: [[String]] = []
    let read = readAttention { args in
      calls.append(args)
      return .exited(status: 0, stdout: Data(self.narrow.utf8))
    }
    XCTAssertEqual(calls, [["attention", "--json"]])
    XCTAssertEqual(read.command, "attention --json")
    XCTAssertEqual(read.items?.map(\.id), ["a"])
    XCTAssertEqual(read.items?.first?.kind, "question")
  }

  func testOlderCliFallsBackToManTend() {
    let read = readAttention { args in
      args == ["attention", "--json"] ? .exited(status: 2, stdout: Data()) : .exited(status: 0, stdout: Data(self.tend.utf8))
    }
    XCTAssertEqual(read.command, "man tend --json")
    XCTAssertEqual(read.items?.map(\.key), ["work:a"])
  }

  func testEveryCommandFailingNamesEachReason() {
    let read = readAttention { args in
      args == ["attention", "--json"] ? .exited(status: 0, stdout: Data("not json".utf8)) : .timedOut
    }
    XCTAssertNil(read.items)
    XCTAssertEqual(read.failure, "`lobstah attention --json` output does not decode (8 bytes); `lobstah man tend --json` timed out")
  }
}

final class ReadMonitorTests: XCTestCase {
  private var dir: URL!

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("lobstah-pet-\(UUID().uuidString)")
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testLogsOnceAtTheThresholdAndOnceOnRecovery() throws {
    var lines: [String] = []
    let file = dir.appendingPathComponent("pet/state.json")
    let monitor = ReadMonitor(threshold: 3, stateFile: file) { lines.append($0) }
    let failed = AttentionRead(items: nil, command: nil, failure: "`lobstah man tend --json` timed out")
    for _ in 0..<5 { monitor.record(failed) }
    XCTAssertEqual(lines, ["attention read failed 3 times in a row: `lobstah man tend --json` timed out"])
    var state = try JSONDecoder().decode(PetState.self, from: Data(contentsOf: file))
    XCTAssertFalse(state.ok)
    XCTAssertEqual(state.consecutiveFailures, 5)
    XCTAssertEqual(state.reason, "`lobstah man tend --json` timed out")
    XCTAssertEqual(state.pid, getpid())

    monitor.record(AttentionRead(items: [], command: "attention --json", failure: nil))
    XCTAssertEqual(lines.count, 3)
    XCTAssertEqual(lines[1], "attention read works again after 5 failures")
    XCTAssertEqual(lines[2], "reading attention with `lobstah attention --json`")
    state = try JSONDecoder().decode(PetState.self, from: Data(contentsOf: file))
    XCTAssertTrue(state.ok)
    XCTAssertEqual(state.items, 0)
    XCTAssertEqual(state.command, "attention --json")
    XCTAssertNotNil(state.lastOkAt)
  }
}
