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

  func testAReviewRequestOpensThePrInItsReviewTool() {
    var item = review(7)
    XCTAssertEqual(item.prLink?.absoluteString, "https://github.com/acme/web/pull/7")
    item.reviewUrl = "https://app.graphite.com/github/pr/acme/web/7"
    XCTAssertEqual(item.prLink?.absoluteString, "https://app.graphite.com/github/pr/acme/web/7")
  }
}
