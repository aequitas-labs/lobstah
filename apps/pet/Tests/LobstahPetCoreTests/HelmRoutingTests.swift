import Foundation
import XCTest
@testable import LobstahPetCore

/// A decision click brings up the live helm's session; with no live helm it opens the glass card.
final class HelmRoutingTests: XCTestCase {
  private let glass = URL(string: "http://127.0.0.1:4949")!
  private let now = ISO8601DateFormatter().date(from: "2026-09-30T17:30:00Z")!
  private let card = URL(string: "http://127.0.0.1:4949/#decision/decision%3A0a1b2c3d")!
  private let decision = AttentionItem(id: "abc", verb: "decision", note: "Cut 0.6.1?", key: "decision:0a1b2c3d", kind: "decision")

  private func helm(heartbeatAgo: TimeInterval = 60, window: HelmWindow?, cwd: String? = "/work/helm") -> HelmRegistration {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return HelmRegistration(sessionId: "7e740e13-30ec-454f-8ada-486fcc43b82d", harness: "claude", cwd: cwd,
                            heartbeatAt: iso.string(from: now.addingTimeInterval(-heartbeatAgo)), window: window)
  }

  /// The click's actions, with the helm's ladder expanded into the steps it would try.
  private func click(_ registration: HelmRegistration?) -> [String] {
    var actions: [String] = []
    clickAttentionItem(decision, glass: glass,
      helmLive: helmIsLive(registration, now: now),
      open: { actions.append("open \($0.absoluteString)") },
      focusHelm: { fallback in
        actions.append(contentsOf: helmFocusSteps(registration, glass: fallback, now: self.now).map { "\($0)" })
      },
      acknowledge: { actions.append($0.joined(separator: " ")) })
    return actions
  }

  func testADesktopHelmBringsUpTheClaudeApp() {
    let desktop = helm(window: HelmWindow(bundleId: "com.anthropic.claudefordesktop"))
    XCTAssertEqual(helmFocusSteps(desktop, glass: card, now: now),
                   [.activateApp(bundleId: "com.anthropic.claudefordesktop"), .openGlass(card)])
    XCTAssertEqual(click(desktop), [
      "\(HelmFocusStep.activateApp(bundleId: "com.anthropic.claudefordesktop"))",
      "\(HelmFocusStep.openGlass(card))",
      "attention ack decision:0a1b2c3d --by pet",
    ])
  }

  func testATerminalHelmKeepsTheTerminalLadder() {
    let iterm = helm(window: HelmWindow(termProgram: "iTerm.app", itermSession: "w0t0p0:ABCD-1234"))
    XCTAssertEqual(helmFocusSteps(iterm, glass: card, now: now), [.itermSession("ABCD-1234"), .openGlass(card)])
    let terminal = helm(window: HelmWindow(bundleId: "com.apple.Terminal", termProgram: "Apple_Terminal", tty: "/dev/ttys004"))
    XCTAssertEqual(helmFocusSteps(terminal, glass: card, now: now),
                   [.terminalTab("/dev/ttys004"), .activateApp(bundleId: "com.apple.Terminal"), .openGlass(card)])
    XCTAssertEqual(click(terminal).first, "\(HelmFocusStep.terminalTab("/dev/ttys004"))")
    let editor = helm(window: HelmWindow(bundleId: "com.microsoft.VSCode"))
    XCTAssertEqual(helmFocusSteps(editor, glass: card, now: now), [.editor(bundleId: "com.microsoft.VSCode", cwd: "/work/helm")])
  }

  func testNoHelmOpensTheDecisionCard() {
    XCTAssertEqual(click(nil), ["open \(card.absoluteString)", "attention ack decision:0a1b2c3d --by pet"])
    XCTAssertEqual(helmFocusSteps(nil, glass: glass, now: now), [.openGlass(glass)])
  }

  func testAStaleHelmIsNotLiveSoADecisionOpensItsCard() {
    let stale = helm(heartbeatAgo: helmLiveSeconds + 60, window: HelmWindow(bundleId: "com.anthropic.claudefordesktop"))
    XCTAssertFalse(helmIsLive(stale, now: now))
    XCTAssertEqual(click(stale), ["open \(card.absoluteString)", "attention ack decision:0a1b2c3d --by pet"])
    // A question click on a stale helm still resumes it, as before.
    XCTAssertEqual(helmFocusSteps(stale, glass: glass, now: now),
                   [.revive(cwd: "/work/helm", command: "claude --resume 7e740e13-30ec-454f-8ada-486fcc43b82d")])
  }

  func testAQuestionStillFocusesTheHelmWithThePlainGlassAsFallback() {
    let question = AttentionItem(id: "abc", verb: "needs-decision", note: nil, key: "work:abc", kind: "question")
    var fallback: URL?
    clickAttentionItem(question, glass: glass, helmLive: true,
      open: { _ in XCTFail("a question focuses the helm") },
      focusHelm: { fallback = $0 },
      acknowledge: { _ in })
    XCTAssertEqual(fallback, glass)
  }

  func testTheHelmFileDecodes() throws {
    let json = #"{"sessionId":"7e740e13","grounds":"fleet","repos":["lobstah"],"signedOnAt":"2026-09-28T16:34:04.649Z","heartbeatAt":"2026-09-30T17:24:54.681Z","harness":"claude","cwd":"/x","window":{"bundleId":"com.anthropic.claudefordesktop"}}"#
    let decoded = try JSONDecoder().decode(HelmRegistration.self, from: Data(json.utf8))
    XCTAssertEqual(decoded.window?.bundleId, "com.anthropic.claudefordesktop")
    XCTAssertTrue(helmIsLive(decoded, now: ISO8601DateFormatter().date(from: "2026-09-30T17:30:00Z")!))
  }
}
