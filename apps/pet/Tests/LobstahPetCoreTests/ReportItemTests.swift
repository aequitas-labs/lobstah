import Foundation
import XCTest
@testable import LobstahPetCore

final class ReportItemTests: XCTestCase {
  func testAReportItemLinksToItsModalInTheSpyglass() throws {
    let json = #"{"attention":[{"id":"abc","verb":"report","note":"Tray findings","key":"report:work:abc","kind":"report"}]}"#
    let report = try JSONDecoder().decode(AttentionReport.self, from: Data(json.utf8))
    let item = try XCTUnwrap(report.attention.first)
    XCTAssertEqual(item.bubbleText, "report · Tray findings")
    XCTAssertNil(item.prLink)
    let link = item.reportLink(glass: URL(string: "http://127.0.0.1:4949")!)
    XCTAssertEqual(link?.absoluteString, "http://127.0.0.1:4949/#report/report%3Awork%3Aabc")
  }

  func testOtherKindsHaveNoReportLink() {
    let item = AttentionItem(id: "abc", verb: "done", note: nil, key: "work:abc", kind: "landed")
    XCTAssertNil(item.reportLink(glass: URL(string: "http://127.0.0.1:4949")!))
  }
}
