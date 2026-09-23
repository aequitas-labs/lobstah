// The lobstah pet: attention questions crawl across the desktop.
//
// One small transparent always-on-top window per attention item (capped),
// each walking the pixel lobster with a star speech bubble. Clicking a
// question pet runs the focus ladder against the helm registration lobstah
// already keeps: exact iTerm pane -> Terminal tab by tty -> VS Code window
// by cwd -> app by bundle id -> resume-if-stale -> the spyglass. Clicking a
// draft-PR pet opens the PR. The pet only ever reads lobstah state
// (`man tend --json` + helm files); it steers nothing.

import AppKit

// MARK: - lobstah state

struct AckInfo: Decodable, Equatable {
  let at: String
  let by: String
}

struct AttentionItem: Decodable, Equatable {
  let id: String
  let verb: String
  let note: String?
  /** The stable item key `lobstah attention ack` takes — absent from an older lobstah. */
  var key: String? = nil
  /** Acknowledged for display: the pet skips it (the helm's wakes never do). */
  var acked: AckInfo? = nil
  /** question | landed | watch | pr:draft | pr:review | pr:checks | pr:ready — absent from an older lobstah. */
  var kind: String? = nil
  /** pr:* kinds: the PR this pet walks for. */
  var prUrl: String? = nil

  /** pr:* pets click through to the PR; question, landed, and watch go to the helm. */
  var prLink: URL? { (kind?.hasPrefix("pr:") ?? false) ? prUrl.flatMap(URL.init(string:)) : nil }

  /** The short kind label shown before the note; nothing for a question. */
  var kindLabel: String? {
    switch kind {
    case "pr:draft": return "draft"
    case "pr:review": return "review"
    case "pr:checks": return "checks"
    case "pr:ready": return "ready"
    case "landed": return "landed"
    case "watch": return "watch"
    default: return nil
    }
  }

  /** Bubble text: the label, then the note. */
  var bubbleText: String {
    let body = note ?? verb
    return kindLabel.map { "\($0) · \(body)" } ?? body
  }
}

struct TendReport: Decodable {
  let attention: [AttentionItem]
}

struct WindowRef: Decodable {
  let bundleId: String?
  let termProgram: String?
  let tty: String?
  let itermSession: String?
  let tmuxPane: String?
}

struct HelmRegistration: Decodable {
  let sessionId: String
  let harness: String?
  let cwd: String?
  let heartbeatAt: String
  let window: WindowRef?
}

/** The spyglass: $LOBSTAH_GLASS_PORT (shared with `lobstah glass`), else 4949. */
let glassURL: URL = {
  let port = ProcessInfo.processInfo.environment["LOBSTAH_GLASS_PORT"].flatMap { Int($0) } ?? 4949
  return URL(string: "http://127.0.0.1:\(port)")!
}()

func lobstahHome() -> URL {
  if let home = ProcessInfo.processInfo.environment["LOBSTAH_HOME"] {
    return URL(fileURLWithPath: home)
  }
  return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".lobstah")
}

func runCommand(_ launch: String, _ args: [String], timeout: TimeInterval = 10) -> String? {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: launch)
  p.arguments = args
  let out = Pipe()
  p.standardOutput = out
  p.standardError = Pipe()
  do { try p.run() } catch { return nil }
  let deadline = Date().addingTimeInterval(timeout)
  while p.isRunning && Date() < deadline { usleep(50_000) }
  if p.isRunning { p.terminate(); return nil }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  return String(data: data, encoding: .utf8)
}

func tendAttention() -> [AttentionItem] {
  guard let json = runCommand("/usr/bin/env", ["lobstah", "man", "tend", "--json"]),
        let data = json.data(using: .utf8),
        let report = try? JSONDecoder().decode(TendReport.self, from: data)
  else { return [] }
  // Acks are display-only: an acked item stays in tend's attention (the helm
  // still needs it) but no longer walks.
  return report.attention.filter { $0.acked == nil }
}

/**
 * Acknowledge through lobstah's own write path — the pet never writes
 * ~/.lobstah itself. Off the main thread; a failure is logged, never shown
 * as a blocker (the click still opened its target).
 */
func ackItem(_ item: AttentionItem) {
  guard let key = item.key else { return }
  DispatchQueue.global().async {
    if runCommand("/usr/bin/env", ["lobstah", "attention", "ack", key, "--by", "pet"]) == nil {
      NSLog("lobstah pet: ack failed for %@", key)
    }
  }
}

func readHelm() -> HelmRegistration? {
  let dir = lobstahHome().appendingPathComponent("helm")
  guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return nil }
  for f in files where f.pathExtension == "json" {
    if let data = try? Data(contentsOf: f),
       let helm = try? JSONDecoder().decode(HelmRegistration.self, from: data) {
      return helm
    }
  }
  return nil
}

// MARK: - focus ladder

func osascript(_ source: String) -> Bool {
  var error: NSDictionary?
  let script = NSAppleScript(source: source)
  script?.executeAndReturnError(&error)
  return error == nil
}

func focusHelm() {
  guard let helm = readHelm() else {
    NSWorkspace.shared.open(glassURL)
    return
  }
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let beat = iso.date(from: helm.heartbeatAt)
    ?? ISO8601DateFormatter().date(from: helm.heartbeatAt)
  let live = beat.map { Date().timeIntervalSince($0) < 1800 } ?? false
  let win = helm.window

  if live {
    // exact iTerm pane
    if let sess = win?.itermSession, let uuid = sess.split(separator: ":").last {
      let ok = osascript("""
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if id of s contains "\(uuid)" then
                  select t
                  select w
                  activate
                  return
                end if
              end repeat
            end repeat
          end repeat
        end tell
        """)
      if ok { return }
    }
    // exact Terminal.app tab by tty
    if let tty = win?.tty, win?.termProgram == "Apple_Terminal" {
      let ok = osascript("""
        tell application "Terminal"
          repeat with w in windows
            repeat with t in tabs of w
              if (tty of t as string) ends with "\(tty)" then
                set selected of t to true
                set frontmost of w to true
                activate
                return
              end if
            end repeat
          end repeat
        end tell
        """)
      if ok { return }
    }
    // VS Code family: one window per folder, cwd is the window
    if let bundle = win?.bundleId, let cwd = helm.cwd,
       bundle.contains("VSCode") || bundle.contains("Cursor") || bundle.contains("windsurf") {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      p.arguments = ["-b", bundle, cwd]
      try? p.run()
      return
    }
    // any recorded app
    if let bundle = win?.bundleId,
       let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
      app.activate()
      return
    }
  } else if let cwd = helm.cwd {
    // stale helm: revive it in a fresh Terminal window
    let resume = helm.harness == "codex" ? "codex resume" : "claude --resume"
    _ = osascript("""
      tell application "Terminal"
        do script "cd \(cwd) && \(resume) \(helm.sessionId)"
        activate
      end tell
      """)
    return
  }
  NSWorkspace.shared.open(glassURL)
}

// MARK: - pet window

final class PetView: NSView {
  weak var pet: Pet?
  override func mouseDown(with event: NSEvent) {
    guard let item = pet?.item else { focusHelm(); return }
    // A click is the human taking it: open the target, and ack so the pet
    // stops walking this state on the next poll.
    if let url = item.prLink { NSWorkspace.shared.open(url) } else { focusHelm() }
    ackItem(item)
  }
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.cursorUpdate, .mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    super.updateTrackingAreas()
  }
  override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
  /** Ack without opening anything. */
  @objc func acknowledge() { if let item = pet?.item { ackItem(item) } }

  override func rightMouseDown(with event: NSEvent) {
    let menu = NSMenu()
    if let url = pet?.item.prLink {
      let open = NSMenuItem(title: "Open PR", action: #selector(NSApplication.petOpenURL(_:)), keyEquivalent: "")
      open.target = NSApp
      open.representedObject = url
      menu.addItem(open)
    }
    if pet?.item.key != nil {
      let ack = NSMenuItem(title: "Acknowledge", action: #selector(PetView.acknowledge), keyEquivalent: "")
      ack.target = self
      menu.addItem(ack)
    }
    let glass = NSMenuItem(title: "Open spyglass", action: #selector(NSApplication.petOpenGlass), keyEquivalent: "")
    glass.target = NSApp
    menu.addItem(glass)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit Lobstah Pet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    quit.target = NSApp
    menu.addItem(quit)
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }
}

extension NSApplication {
  @objc func petOpenGlass() {
    NSWorkspace.shared.open(glassURL)
  }
  @objc func petOpenURL(_ sender: NSMenuItem) {
    if let url = sender.representedObject as? URL { NSWorkspace.shared.open(url) }
  }
}

final class Pet {
  static let spriteSheet: NSImage? = Bundle.module.url(forResource: "lob-sprite", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
  static let starImage: NSImage? = Bundle.module.url(forResource: "star", withExtension: "png").flatMap { NSImage(contentsOf: $0) }

  let item: AttentionItem
  let panel: NSPanel
  let spriteLayer = CALayer()
  var x: CGFloat
  let speed: CGFloat
  var frame = 0
  /** All displays, left to right; the pet crosses each in turn. */
  let screens: [NSScreen]
  var screenIndex = 0
  /** Between displays the pet is simply gone for a beat, then re-enters. */
  var hiddenUntil: Date?
  /** Where the current entrance began — drives the fade-in. */
  var entryX: CGFloat = -10_000
  /** Hovered: the walk pauses, the bubble reveals; the arms keep waving. */
  var hovered = false { didSet { bubble?.isHidden = !hovered } }
  weak var bubble: NSView?

  init(item: AttentionItem, index: Int) {
    self.item = item
    let text = item.bubbleText
    self.screens = NSScreen.screens.sorted { $0.frame.minX < $1.frame.minX }
    self.speed = 100 + CGFloat(index) * 12
    let first = screens.first?.frame ?? .zero
    self.x = first.minX - 200 - CGFloat(index) * 220
    self.entryX = self.x

    let panelW: CGFloat = 300
    let panelH: CGFloat = 150
    panel = NSPanel(
      contentRect: NSRect(x: x, y: 0, width: panelW, height: panelH),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false
    )
    panel.level = .floating
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.ignoresMouseEvents = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.acceptsMouseMovedEvents = true

    let root = PetView(frame: NSRect(x: 0, y: 0, width: panelW, height: panelH))
    root.wantsLayer = true
    panel.contentView = root

    // sprite: one frame of the 4-frame sheet, pixel-crisp at 1.5x
    let spriteW: CGFloat = 108, spriteH: CGFloat = 84
    spriteLayer.frame = CGRect(x: 168, y: 0, width: spriteW, height: spriteH)
    if let sheet = Pet.spriteSheet {
      var rect = CGRect(origin: .zero, size: sheet.size)
      spriteLayer.contents = sheet.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }
    spriteLayer.contentsRect = CGRect(x: 0, y: 0, width: 0.25, height: 1)
    spriteLayer.magnificationFilter = .nearest
    root.layer?.addSublayer(spriteLayer)

    // the question is a hover reveal, fully above the lobster, sized to fit
    let bubble = NSView(frame: NSRect(x: 40, y: 88, width: 236, height: 58))
    bubble.isHidden = true
    bubble.wantsLayer = true
    bubble.layer?.backgroundColor = NSColor(calibratedRed: 0.086, green: 0.106, blue: 0.133, alpha: 0.96).cgColor
    bubble.layer?.borderColor = NSColor(calibratedWhite: 0.35, alpha: 1).cgColor
    bubble.layer?.borderWidth = 1
    bubble.layer?.cornerRadius = 10

    // the star rides above the claw — the glass's geometry scaled 1.5x
    let star = NSImageView(frame: NSRect(x: 168 + 82, y: spriteH - 9, width: 22, height: 22))
    star.image = Pet.starImage
    star.imageScaling = .scaleProportionallyUpOrDown
    star.wantsLayer = true
    star.layer?.magnificationFilter = .nearest

    let label = NSTextField(wrappingLabelWithString: text.count > 66 ? String(text.prefix(63)) + "…" : text)
    label.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
    let fitted = label.sizeThatFits(NSSize(width: 216, height: 120))
    bubble.setFrameSize(NSSize(width: min(236, fitted.width + 20), height: fitted.height + 12))
    bubble.setFrameOrigin(NSPoint(x: 276 - bubble.frame.width, y: 88))
    label.frame = NSRect(x: 10, y: 6, width: fitted.width, height: fitted.height)
    label.textColor = NSColor(calibratedRed: 0.86, green: 0.89, blue: 0.92, alpha: 1)
    label.maximumNumberOfLines = 3
    label.cell?.truncatesLastVisibleLine = true
    bubble.addSubview(label)
    root.addSubview(bubble)
    root.addSubview(star)
    root.pet = self
    self.bubble = bubble

    panel.orderFrontRegardless()
  }

  func tick(_ dt: CGFloat) {
    // Tracking areas miss a window that walks under a stationary cursor, in
    // both directions — poll instead.
    let inside = panel.frame.contains(NSEvent.mouseLocation) && panel.isVisible
    if inside != hovered {
      hovered = inside
      if !inside { NSCursor.arrow.set() }
    }
    if inside { NSCursor.pointingHand.set() }
    if let until = hiddenUntil {
      if Date() < until { return }
      hiddenUntil = nil
      panel.orderFrontRegardless()
    }
    if !hovered { x += speed * dt }
    let current = screens[screenIndex]
    // Leaving a display: fade over the last stretch, vanish before leaking
    // onto the neighbor, pause a beat offstage, then fade in at the next
    // display's edge.
    let cutoff = current.frame.maxX - panel.frame.width
    if x > cutoff {
      panel.orderOut(nil)
      screenIndex = (screenIndex + 1) % screens.count
      x = screens[screenIndex].frame.minX + 2
      entryX = x
      hiddenUntil = Date().addingTimeInterval(2.5)
      return
    }
    let fadeOut = max(0, min(1, (cutoff - x) / 110))
    let fadeIn = max(0, min(1, (x - entryX) / 40))
    panel.alphaValue = min(fadeOut, fadeIn)
    // visibleFrame keeps the walk above the Dock
    panel.setFrameOrigin(NSPoint(x: x, y: screens[screenIndex].visibleFrame.minY + 2))
  }

  func step() {
    frame = (frame + 1) % 4
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    spriteLayer.contentsRect = CGRect(x: CGFloat(frame) / 4, y: 0, width: 0.25, height: 1)
    CATransaction.commit()
  }

  func close() { panel.orderOut(nil) }
}

// MARK: - app

final class AppDelegate: NSObject, NSApplicationDelegate {
  var pets: [Pet] = []
  var lastKey = ""
  var statusItem: NSStatusItem?
  var preview = ProcessInfo.processInfo.environment["LOBSTAH_PET_PREVIEW"] != nil

  var activity: NSObjectProtocol?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    // Accessory apps get App-Napped and their timers throttled — which
    // reads as the pet walking in slow motion. Hold an activity assertion.
    activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "pet animation")

    // No menu-bar presence by default: the pet IS the UI (right-click it
    // for spyglass/quit). LOBSTAH_PET_MENUBAR=1 restores the status item.
    if ProcessInfo.processInfo.environment["LOBSTAH_PET_MENUBAR"] != nil {
      statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
      statusItem?.button?.title = "🦞"
      let menu = NSMenu()
      menu.addItem(NSMenuItem(title: "Preview pet", action: #selector(togglePreview), keyEquivalent: "p"))
      menu.addItem(NSMenuItem(title: "Open spyglass", action: #selector(openGlass), keyEquivalent: "g"))
      menu.addItem(.separator())
      menu.addItem(NSMenuItem(title: "Quit Lobstah Pet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
      for item in menu.items { item.target = self }
      statusItem?.menu = menu
    }

    // walk + frame-step + poll timers. The walk uses measured elapsed
    // time: runloop timers drift, and a fixed nominal dt turns every
    // dropped tick into lost distance.
    var lastTick = CACurrentMediaTime()
    let walker = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in
      let now = CACurrentMediaTime()
      let dt = CGFloat(min(0.35, now - lastTick))
      lastTick = now
      for pet in self.pets { pet.tick(dt) }
    }
    walker.tolerance = 0.002
    Timer.scheduledTimer(withTimeInterval: 0.14, repeats: true) { _ in
      for pet in self.pets { pet.step() }
    }
    Timer.scheduledTimer(withTimeInterval: 6, repeats: true) { _ in self.poll() }
    poll()
  }

  @objc func togglePreview() {
    preview.toggle()
    lastKey = "-"
    poll()
  }

  @objc func openGlass() {
    NSWorkspace.shared.open(glassURL)
  }

  func poll() {
    DispatchQueue.global().async {
      var items = tendAttention()
      DispatchQueue.main.async {
        if items.isEmpty && self.preview {
          items = [AttentionItem(id: "preview", verb: "needs-decision", note: "the lobster preview — questions crawl in here")]
        }
        let extra = items.count > 4 ? items.count - 4 : 0
        var shown = Array(items.prefix(4))
        if extra > 0 {
          let last = shown.removeLast()
          shown.append(AttentionItem(id: last.id, verb: last.verb, note: (last.note ?? last.verb) + " (+\(extra) more)", key: last.key, kind: last.kind, prUrl: last.prUrl))
        }
        let key = shown.map { "\($0.kind ?? "question"):\($0.key ?? $0.id)" }.joined(separator: "|")
        guard key != self.lastKey else { return }
        self.lastKey = key
        for pet in self.pets { pet.close() }
        self.pets = shown.enumerated().map { i, item in
          Pet(item: item, index: i)
        }
      }
    }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
