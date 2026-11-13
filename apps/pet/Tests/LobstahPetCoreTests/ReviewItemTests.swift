import Foundation
import XCTest
@testable import LobstahPetCore

final class ReviewItemTests: XCTestCase {
  private let glass = URL(string: "http://127.0.0.1:4949")!

  private func review(_ n: Int) -> AttentionItem {
    AttentionItem(id: "review:acme/web#\(n)", verb: "drafted", note: "acme/web#\(n) Add the thing", key: "review:acme/web#\(n)", kind: "review", prUrl: "https://github.com/acme/web/pull/\(n)", stateHash: "h")
  }

  func testDraftNotificationTextAndReviewInboxTarget() {
    var item = review(7)
    item.reviewUrl = "linear://review/acme/web/pull/7"
    XCTAssertEqual(item.prLink?.absoluteString, "linear://review/acme/web/pull/7")
    XCTAssertNil(item.kindLabel)
    XCTAssertEqual(item.glassTarget(glass: glass)?.hash, "#pr/pr%3Aacme%2Fweb%237")
    XCTAssertEqual(item.glassTarget(glass: glass)?.url.absoluteString, "http://127.0.0.1:4949#pr/pr%3Aacme%2Fweb%237")
    var commands: [[String]] = []
    var opened: [URL] = []
    clickAttentionItem(item, glass: glass, open: { opened.append($0) }, focusHelm: { _ in }, acknowledge: { commands.append($0) })
    XCTAssertEqual(commands, [])
    XCTAssertEqual(opened.first?.fragment, "pr/pr%3Aacme%2Fweb%237")
    XCTAssertEqual(item.ackArguments, ["attention", "ack", "review:acme/web#7", "--by", "pet"])
  }
  func testDraftOpensPrViewWithoutHidingItAndRetainsOpenPrMenuLink() {
    var item = AttentionItem(id: "pr:acme/web#7", verb: "draft", note: nil, key: "pr:acme/web#7", kind: "pr:draft", prUrl: "https://github.com/acme/web/pull/7")
    item.reviewUrl = "https://review.example/acme/web/7"
    var opened: [URL] = []
    var commands: [[String]] = []
    clickAttentionItem(item, glass: glass, open: { opened.append($0) }, focusHelm: { _ in }, acknowledge: { commands.append($0) })
    XCTAssertEqual(opened.first?.absoluteString, "http://127.0.0.1:4949#pr/pr%3Aacme%2Fweb%237")
    XCTAssertEqual(commands, [])
    XCTAssertEqual(item.prLink?.absoluteString, "https://review.example/acme/web/7")
  }
}
