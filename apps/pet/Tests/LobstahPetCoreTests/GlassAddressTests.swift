import Foundation
import XCTest
@testable import LobstahPetCore

/// An item of a grounds on a wharf opens the wharf's hosted glass; every
/// other item opens the local glass. The item says which, not a setting.
final class GlassAddressTests: XCTestCase {
  private let local = URL(string: "http://127.0.0.1:4949")!
  private let hostedJob = "https://glass.example/#job/remote-job"

  /// What a click did, in order.
  private func click(_ item: AttentionItem, helmLive: Bool = false) -> [String] {
    var actions: [String] = []
    clickAttentionItem(item, glass: local, helmLive: helmLive,
      open: { actions.append("open \($0.absoluteString)") },
      focusHelm: { actions.append("helm, else \($0.absoluteString)") },
      showGlass: { target, _ in actions.append("show \(target.hash)") },
      acknowledge: { actions.append($0.joined(separator: " ")) })
    return actions
  }

  func testTheAttentionReadCarriesAWharfItemsGroundsAndGlass() throws {
    let json = #"{"attention":[{"id":"srv-1","verb":"needs-decision","note":"[away@cloud] which?","key":"work:srv-1","kind":"question","stateHash":"h","grounds":"away","wharf":"cloud","glass":"https://glass.example/#job/remote-job"},{"id":"abc","verb":"blocked","note":"stuck","key":"work:abc","kind":"question","stateHash":"h"}]}"#
    let items = try JSONDecoder().decode(AttentionReport.self, from: Data(json.utf8)).attention
    XCTAssertEqual(items[0].grounds, "away")
    XCTAssertEqual(items[0].glassAddress(local: local), GlassAddress(url: URL(string: hostedJob)!, hosted: true))
    XCTAssertNil(items[1].grounds)
    XCTAssertEqual(items[1].glassAddress(local: local), GlassAddress(url: local, hosted: false))
  }

  func testAWharfQuestionOpensItsHostedGlassAndALocalOneGoesToTheHelm() {
    // This boat holds no helm registration for a wharf grounds: a live local helm is another grounds'.
    let hosted = AttentionItem(id: "srv-1", verb: "needs-decision", note: "which?", key: "work:srv-1", kind: "question", grounds: "away", glass: hostedJob)
    XCTAssertEqual(click(hosted), ["open \(hostedJob)", "attention ack work:srv-1 --by pet"])
    XCTAssertEqual(click(hosted, helmLive: true), ["open \(hostedJob)", "attention ack work:srv-1 --by pet"])
    let home = AttentionItem(id: "abc", verb: "needs-decision", note: "which?", key: "work:abc", kind: "question")
    XCTAssertEqual(click(home), ["helm, else http://127.0.0.1:4949", "attention ack work:abc --by pet"])
  }

  func testAWharfItemWithoutAGlassYetKeepsTodaysClick() {
    // The wharf has not named its glass (an older wharf, or no answer yet).
    let item = AttentionItem(id: "srv-1", verb: "done", note: "landed", key: "work:srv-1", kind: "landed", grounds: "away")
    XCTAssertEqual(item.glassAddress(local: local), GlassAddress(url: local, hosted: false))
    XCTAssertEqual(click(item), ["helm, else http://127.0.0.1:4949", "attention ack work:srv-1 --by pet"])
  }

  func testAHostedReportOrDecisionOpensItsLinkAndNeverMovesALocalGlassPage() {
    let report = AttentionItem(id: "r", verb: "report", note: "Findings", key: "report:r1", kind: "report", grounds: "away", glass: "https://glass.example/#report/r1")
    XCTAssertEqual(click(report), ["open https://glass.example/#report/r1", "attention ack report:r1 --by pet"])
    let decision = AttentionItem(id: "d", verb: "decision", note: "Cut it?", key: "decision:d1", kind: "decision", grounds: "away", glass: "https://glass.example/#decision/d1")
    XCTAssertEqual(click(decision), ["open https://glass.example/#decision/d1", "attention ack decision:d1 --by pet"])
    XCTAssertEqual(click(decision, helmLive: true), ["open https://glass.example/#decision/d1", "attention ack decision:d1 --by pet"])
    // The local ones still ask an open local page first.
    let home = AttentionItem(id: "d", verb: "decision", note: "Cut it?", key: "decision:d1", kind: "decision")
    XCTAssertEqual(click(home), ["show #decision/decision%3Ad1", "attention ack decision:d1 --by pet"])
  }

  func testOnlyAnHTTPSOrLoopbackLinkCountsAsAHostedGlass() {
    func address(_ glass: String) -> GlassAddress {
      AttentionItem(id: "x", verb: "done", note: nil, key: "work:x", kind: "landed", glass: glass).glassAddress(local: local)
    }
    XCTAssertTrue(address("https://glass.example/#job/a").hosted)
    XCTAssertTrue(address("http://127.0.0.1:8788/#job/a").hosted)
    XCTAssertTrue(address("http://localhost:8788/#job/a").hosted)
    for refused in ["http://glass.example/#job/a", "file:///etc/passwd", "javascript:alert(1)", "claude://claude.ai/x",
                    "https://user:secret@glass.example/#job/a", "not a url", ""] {
      XCTAssertEqual(address(refused), GlassAddress(url: local, hosted: false), refused)
    }
  }

  func testAPullRequestOnAWharfGroundsStillOpensThePullRequest() {
    let pr = AttentionItem(id: "p", verb: "pr", note: nil, key: "pr:o/r#1", kind: "pr:ready", prUrl: "https://github.com/o/r/pull/1", grounds: "away", glass: hostedJob)
    XCTAssertNil(pr.glassTarget(glass: local))
    XCTAssertEqual(click(pr), ["open https://github.com/o/r/pull/1", "attention ack pr:o/r#1 --by pet"])
  }
}
