import Foundation
import XCTest
@testable import LobstahPetCore

final class ReportItemTests: XCTestCase {
  private var previousHome: String?
  private var testHome: URL!

  override func setUpWithError() throws {
    previousHome = ProcessInfo.processInfo.environment["LOBSTAH_HOME"]
    testHome = FileManager.default.temporaryDirectory.appendingPathComponent("lobstah-report-click-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: testHome, withIntermediateDirectories: true)
    setenv("LOBSTAH_HOME", testHome.path, 1)
  }

  override func tearDownWithError() throws {
    if let previousHome { setenv("LOBSTAH_HOME", previousHome, 1) } else { unsetenv("LOBSTAH_HOME") }
    try FileManager.default.removeItem(at: testHome)
  }

  func testAReportItemLinksToItsModalInTheSpyglass() throws {
    let json = #"{"attention":[{"id":"abc","verb":"report","note":"Tray findings","key":"report:work:abc","kind":"report"}]}"#
    let report = try JSONDecoder().decode(AttentionReport.self, from: Data(json.utf8))
    let item = try XCTUnwrap(report.attention.first)
    XCTAssertEqual(item.bubbleText, "report · Tray findings")
    XCTAssertNil(item.prLink)
    let link = item.reportLink(glass: URL(string: "http://127.0.0.1:4949")!)
    XCTAssertEqual(link?.absoluteString, "http://127.0.0.1:4949/report/report%3Awork%3Aabc")
  }

  func testOtherKindsHaveNoReportLink() {
    let item = AttentionItem(id: "abc", verb: "done", note: nil, key: "work:abc", kind: "landed")
    XCTAssertNil(item.reportLink(glass: URL(string: "http://127.0.0.1:4949")!))
  }

  func testReportClickOpensBeforeAcknowledgingThroughThePetCommand() {
    let item = AttentionItem(id: "abc", verb: "report", note: nil, key: "report:work:abc", kind: "report")
    var actions: [String] = []
    var commands: [[String]] = []
    let run: LobstahRunner = { args in
      actions.append("ack")
      commands.append(args)
      return .exited(status: 0, stdout: Data())
    }
    clickAttentionItem(item, glass: URL(string: "http://127.0.0.1:4949")!,
      open: { actions.append($0.absoluteString) },
      focusHelm: { XCTFail("a report opens its glass URL") },
      acknowledge: { _ = ackOutcome(run($0)) })
    XCTAssertEqual(actions, ["http://127.0.0.1:4949/report/report%3Awork%3Aabc", "ack"])
    XCTAssertEqual(commands, [["attention", "ack", "report:work:abc", "--by", "pet"]])
  }

  func testFailedAcknowledgementDoesNotPreventOpeningTheReport() {
    let item = AttentionItem(id: "abc", verb: "report", note: nil, key: "report:work:abc", kind: "report")
    var opened = false
    var failure: ReadFailure?
    clickAttentionItem(item, glass: URL(string: "http://127.0.0.1:4949")!,
      open: { _ in opened = true },
      focusHelm: { XCTFail("a report opens its glass URL") },
      acknowledge: { _ in
        XCTAssertTrue(opened)
        if case let .failure(why) = ackOutcome(.exited(status: 1, stdout: Data())) { failure = why }
      })
    XCTAssertTrue(opened)
    XCTAssertEqual(failure, .exit(1))
  }

  func testOtherPetClicksKeepTheirTargetsAndAcknowledge() {
    let glass = URL(string: "http://127.0.0.1:4949")!
    let pr = "https://github.com/example/repo/pull/1"
    for kind in ["question", "landed", "watch", "pr:ready"] {
      let item = AttentionItem(id: "abc", verb: "done", note: nil, key: "work:abc", kind: kind, prUrl: pr)
      var actions: [String] = []
      clickAttentionItem(item, glass: glass,
        open: { actions.append($0.absoluteString) },
        focusHelm: { actions.append("helm") },
        acknowledge: { actions.append($0.joined(separator: " ")) })
      XCTAssertEqual(actions, [kind == "pr:ready" ? pr : "helm", "attention ack work:abc --by pet"], kind)
    }
  }

  func testLegacyItemWithoutAKeyStillOpensWithoutAnAck() {
    let item = AttentionItem(id: "abc", verb: "needs-decision", note: nil)
    var focused = false
    clickAttentionItem(item, glass: URL(string: "http://127.0.0.1:4949")!,
      open: { _ in XCTFail("a legacy question focuses the helm") },
      focusHelm: { focused = true },
      acknowledge: { _ in XCTFail("an item without a key cannot be acknowledged") })
    XCTAssertTrue(focused)
  }
}
