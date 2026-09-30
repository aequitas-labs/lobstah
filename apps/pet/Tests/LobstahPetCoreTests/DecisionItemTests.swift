import Foundation
import XCTest
@testable import LobstahPetCore

final class DecisionItemTests: XCTestCase {
  private let glass = URL(string: "http://127.0.0.1:4949")!

  func testADecisionShowsItsTitleOnly() throws {
    let json = #"{"attention":[{"id":"abc","verb":"decision","note":"Cut 0.6.0?","key":"decision:0a1b2c3d","kind":"decision","stateHash":"h"}]}"#
    let report = try JSONDecoder().decode(AttentionReport.self, from: Data(json.utf8))
    let item = try XCTUnwrap(report.attention.first)
    XCTAssertNil(item.kindLabel)
    XCTAssertEqual(item.bubbleText, "Cut 0.6.0?")
  }

  func testADecisionLinksToItsCardInTheSpyglass() {
    let item = AttentionItem(id: "abc", verb: "decision", note: "Cut 0.6.0?", key: "decision:0a1b2c3d", kind: "decision")
    XCTAssertEqual(item.decisionLink(glass: glass)?.absoluteString, "http://127.0.0.1:4949/#decision/decision%3A0a1b2c3d")
    let question = AttentionItem(id: "abc", verb: "needs-decision", note: nil, key: "work:abc", kind: "question")
    XCTAssertNil(question.decisionLink(glass: glass))
  }

  func testADecisionClickOpensTheCardThenAcknowledges() {
    let item = AttentionItem(id: "abc", verb: "decision", note: "Cut 0.6.0?", key: "decision:0a1b2c3d", kind: "decision")
    var actions: [String] = []
    clickAttentionItem(item, glass: glass,
      open: { actions.append($0.absoluteString) },
      focusHelm: { XCTFail("a decision opens its glass card") },
      acknowledge: { actions.append($0.joined(separator: " ")) })
    XCTAssertEqual(actions, [
      "http://127.0.0.1:4949/#decision/decision%3A0a1b2c3d",
      "attention ack decision:0a1b2c3d --by pet",
    ])
  }
}
