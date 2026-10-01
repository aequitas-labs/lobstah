import Foundation
import XCTest
@testable import LobstahPetCore

final class ClickedItemsTests: XCTestCase {
  private func ready(_ hash: String?) -> AttentionItem {
    AttentionItem(id: "p", verb: "pr:ready", note: "#9 ready to merge", key: "pr:acme/web#9", kind: "pr:ready",
                  prUrl: "https://github.com/acme/web/pull/9", stateHash: hash)
  }
  private let report = AttentionItem(id: "r", verb: "report", note: "findings", key: "report:work:r", kind: "report", stateHash: "r1")

  func testTheReadDecodesStateHash() throws {
    let json = #"{"attention":[{"id":"p","verb":"pr:ready","key":"pr:acme/web#9","kind":"pr:ready","stateHash":"h1"}]}"#
    let item = try XCTUnwrap(try JSONDecoder().decode(AttentionReport.self, from: Data(json.utf8)).attention.first)
    XCTAssertEqual(item.stateHash, "h1")
  }

  /// The ack timed out, so every read still lists the item unacked: the click alone keeps it hidden.
  func testAClickedItemStaysHiddenWhileItsStateIsUnchanged() {
    var clicked = ClickedItems()
    clicked.hide(ready("h1"))
    XCTAssertEqual(clicked.walking([ready("h1"), report]), [report])
    XCTAssertEqual(clicked.walking([ready("h1"), report]), [report])
  }

  func testANewStateHashWalksAgain() {
    var clicked = ClickedItems()
    clicked.hide(ready("h1"))
    XCTAssertEqual(clicked.walking([ready("h2")]), [ready("h2")])
    // The hide is forgotten: the old hash coming back does not hide it again.
    XCTAssertEqual(clicked.walking([ready("h1")]), [ready("h1")])
  }

  func testOnceTheAckLandsTheHideIsForgotten() {
    var clicked = ClickedItems()
    clicked.hide(ready("h1"))
    XCTAssertEqual(clicked.walking([]), []) // the read drops the acked item
    XCTAssertEqual(clicked.walking([ready("h1")]), [ready("h1")]) // `attention unack` walks it again
  }

  func testAnItemWithoutAStateHashWaitsForTheCliAck() {
    var clicked = ClickedItems()
    clicked.hide(ready(nil))
    XCTAssertEqual(clicked.walking([ready(nil)]), [ready(nil)])
  }
}
