import Foundation

/// How a child process ended.
public enum CommandOutcome: Equatable {
  /// The child exited (or died on a signal: status 128 + signal) and its
  /// standard output reached end of file.
  case exited(status: Int32, stdout: Data)
  /// The child ran past the timeout, or held its standard output open past
  /// it. The child was terminated.
  case timedOut
  /// The child did not start.
  case launchFailed(String)
}

public struct CommandResult {
  public let outcome: CommandOutcome
  /// The child's pid; 0 when it did not start.
  public let pid: Int32
}

/// Collects standard output as it arrives. The readability handler runs on
/// a Foundation queue; the lock guards the buffer and the end-of-file flag.
private final class OutputCollector {
  private let lock = NSLock()
  private var data = Data()
  private var ended = false
  let eof = DispatchSemaphore(value: 0)

  func append(_ chunk: Data) {
    lock.lock()
    defer { lock.unlock() }
    if chunk.isEmpty {
      if !ended { ended = true; eof.signal() }
    } else {
      data.append(chunk)
    }
  }

  var collected: Data {
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}

/// Runs `launch args` and reads its standard output while it runs, so
/// output of any size works: a pipe holds only about 64 KB, and a child
/// that fills it blocks until someone reads. Standard error and standard
/// input go to the null device, so neither can block the child.
///
/// After `timeout` seconds the child gets SIGTERM, then SIGKILL one second
/// later if it is still alive, and the result is `.timedOut`.
public func execute(_ launch: String, _ args: [String], timeout: TimeInterval = 10) -> CommandResult {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: launch)
  p.arguments = args
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.nullDevice
  p.standardInput = FileHandle.nullDevice
  let exited = DispatchSemaphore(value: 0)
  p.terminationHandler = { _ in exited.signal() }

  let collector = OutputCollector()
  let reader = out.fileHandleForReading
  reader.readabilityHandler = { handle in collector.append(handle.availableData) }
  let stopReading = {
    reader.readabilityHandler = nil
    try? reader.close()
  }

  do { try p.run() } catch {
    stopReading()
    return CommandResult(outcome: .launchFailed(error.localizedDescription), pid: 0)
  }
  let pid = p.processIdentifier
  let deadline = DispatchTime.now() + timeout

  if exited.wait(timeout: deadline) == .timedOut {
    p.terminate()
    if exited.wait(timeout: .now() + 1) == .timedOut {
      kill(pid, SIGKILL)
      _ = exited.wait(timeout: .now() + 1)
    }
    stopReading()
    return CommandResult(outcome: .timedOut, pid: pid)
  }
  // The child is gone. The end of file can trail its exit by a moment; a
  // descendant that still holds the pipe open counts as a timeout.
  let eofDeadline = max(deadline, DispatchTime.now() + 1)
  if collector.eof.wait(timeout: eofDeadline) == .timedOut {
    stopReading()
    return CommandResult(outcome: .timedOut, pid: pid)
  }
  stopReading()
  let status = p.terminationReason == .uncaughtSignal ? 128 + p.terminationStatus : p.terminationStatus
  return CommandResult(outcome: .exited(status: status, stdout: collector.collected), pid: pid)
}

/// Standard output as UTF-8 when the child exits 0; nil on a timeout, a
/// non-zero exit, a launch failure, or output that is not UTF-8.
public func runCommand(_ launch: String, _ args: [String], timeout: TimeInterval = 10) -> String? {
  guard case let .exited(status, data) = execute(launch, args, timeout: timeout).outcome, status == 0 else { return nil }
  return String(data: data, encoding: .utf8)
}
