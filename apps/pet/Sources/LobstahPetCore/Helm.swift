import Foundation

// MARK: - the helm registration the pet reads

public struct HelmWindow: Decodable, Equatable {
  public var bundleId: String?
  public var termProgram: String?
  public var tty: String?
  public var itermSession: String?
  public var tmuxPane: String?

  public init(bundleId: String? = nil, termProgram: String? = nil, tty: String? = nil, itermSession: String? = nil, tmuxPane: String? = nil) {
    self.bundleId = bundleId
    self.termProgram = termProgram
    self.tty = tty
    self.itermSession = itermSession
    self.tmuxPane = tmuxPane
  }
}

public struct HelmRegistration: Decodable, Equatable {
  public var sessionId: String
  public var harness: String?
  public var cwd: String?
  public var heartbeatAt: String
  public var window: HelmWindow?
  /** The helm's own session link (`claude://claude.ai/...`), when its registration carries one. */
  public var link: String?

  public init(sessionId: String, harness: String? = nil, cwd: String? = nil, heartbeatAt: String, window: HelmWindow? = nil, link: String? = nil) {
    self.sessionId = sessionId
    self.harness = harness
    self.cwd = cwd
    self.heartbeatAt = heartbeatAt
    self.window = window
    self.link = link
  }
}

/// A helm is live while its heartbeat is under 30 minutes old.
public let helmLiveSeconds: TimeInterval = 1800

public func helmIsLive(_ helm: HelmRegistration?, now: Date = Date()) -> Bool {
  guard let helm else { return false }
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let beat = iso.date(from: helm.heartbeatAt) ?? ISO8601DateFormatter().date(from: helm.heartbeatAt) else { return false }
  return now.timeIntervalSince(beat) < helmLiveSeconds
}

// MARK: - the focus ladder

/// One way to bring up the helm's session, tried in order until one works.
public enum HelmFocusStep: Equatable {
  /// The exact iTerm2 session, by its id.
  case itermSession(String)
  /// The exact Terminal.app tab, by its tty.
  case terminalTab(String)
  /// A VS Code-family window: its bundle opened on the helm's folder.
  case editor(bundleId: String, cwd: String)
  /// The app the helm runs in (the Claude desktop app, or any recorded app), brought to the front.
  case activateApp(bundleId: String)
  /// A stale helm: resume its session in a new Terminal window.
  case revive(cwd: String, command: String)
  /// No helm step worked: open the spyglass at this URL.
  case openGlass(URL)
}

private func isEditor(_ bundle: String) -> Bool {
  bundle.contains("VSCode") || bundle.contains("Cursor") || bundle.contains("windsurf")
}

/// The helm's focus ladder, as steps: the exact iTerm2 pane, the Terminal tab
/// by tty, a VS Code-family window by folder, then the app by bundle id (the
/// Claude desktop app for a desktop helm), then the spyglass. A stale helm is
/// resumed in a new Terminal window instead. With no helm, only the spyglass.
public func helmFocusSteps(_ helm: HelmRegistration?, glass: URL, now: Date = Date()) -> [HelmFocusStep] {
  guard let helm else { return [.openGlass(glass)] }
  guard helmIsLive(helm, now: now) else {
    if let cwd = helm.cwd {
      let resume = helm.harness == "codex" ? "codex resume" : "claude --resume"
      return [.revive(cwd: cwd, command: "\(resume) \(helm.sessionId)")]
    }
    return [.openGlass(glass)]
  }
  var steps: [HelmFocusStep] = []
  let win = helm.window
  if let sess = win?.itermSession, let uuid = sess.split(separator: ":").last {
    steps.append(.itermSession(String(uuid)))
  }
  if let tty = win?.tty, win?.termProgram == "Apple_Terminal" {
    steps.append(.terminalTab(tty))
  }
  if let bundle = win?.bundleId, let cwd = helm.cwd, isEditor(bundle) {
    // An editor window is its folder: opening it is the last step that can run.
    steps.append(.editor(bundleId: bundle, cwd: cwd))
    return steps
  }
  if let bundle = win?.bundleId {
    steps.append(.activateApp(bundleId: bundle))
  }
  steps.append(.openGlass(glass))
  return steps
}
