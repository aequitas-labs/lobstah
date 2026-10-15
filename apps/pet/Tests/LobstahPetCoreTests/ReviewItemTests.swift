import Foundation
import XCTest
@testable import LobstahPetCore

final class ReviewItemTests: XCTestCase {
  private let glass = URL(string: "http://127.0.0.1:4949")!

  private func review(_ n: Int) -> AttentionItem {
    AttentionItem(id: "review:acme/web#\(n)", verb: "drafted", note: "acme/web#\(n) Add the thing", key: "review:acme/web#\(n)", kind: "review", prUrl: "https://github.com/acme/web/pull/\(n)", stateHash: "h")
  }

  func testAReviewRequestHasItsOwnLabel() {
    XCTAssertEqual(review(7).kindLabel, "review request")
    XCTAssertEqual(review(7).bubbleText, "review request · acme/web#7 Add the thing")
  }

  func testAReviewRequestOpensTheReviewsTabNotThePr() {
    let item = review(7)
    XCTAssertNil(item.prLink)
    XCTAssertEqual(item.glassTarget(glass: glass), GlassTarget(hash: "#reviews", url: URL(string: "http://127.0.0.1:4949/#reviews")!))
  }

  func testTheMenuBarCountsReviewsApart() {
    let decision = AttentionItem(id: "d", verb: "decision", note: "Cut?", key: "decision:1", kind: "decision")
    XCTAssertEqual(AttentionItem.statusTitle([decision]), "🦞")
    XCTAssertEqual(AttentionItem.statusTitle([decision, review(7), review(8)]), "🦞 ✎2")
  }
}
