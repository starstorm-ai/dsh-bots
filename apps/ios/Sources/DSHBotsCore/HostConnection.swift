import Foundation
import Security
import CryptoKit

/// Only the trust callback mutates this diagnostic; URLSession callbacks may use different threads.
private final class TrustDiagnostic: @unchecked Sendable {
    private let lock = NSLock()
    private var failure: HostError?
    func set(_ value: HostError) { lock.lock(); defer { lock.unlock() }; failure = value }
    func get() -> HostError? { lock.lock(); defer { lock.unlock() }; return failure }
}
/// A private session, scoped to one scanned certificate. No global trust override or redirects.
private final class PinnedSession: NSObject, URLSessionDelegate, URLSessionTaskDelegate, Sendable {
    let fingerprint: String
    let hostname: String
    let diagnostic = TrustDiagnostic()
    init(fingerprint: String, hostname: String) { self.fingerprint = fingerprint; self.hostname = hostname }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == hostname,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let hash = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
        guard hash == fingerprint else { diagnostic.set(HostError("CERTIFICATE_MISMATCH", "电脑证书与扫码记录不一致，请确认电脑身份后重新扫码")); completionHandler(.cancelAuthenticationChallenge, nil); return }
        // This private, self-signed identity is authenticated by the exact QR DER pin.
        // Basic X.509 still verifies signature/validity against that sole anchor.
        // Web-PKI SSL issuance lifetime limits reject the existing Host's ten-year
        // private certificate. No system roots or hostname-only trust are accepted.
        SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        guard SecTrustEvaluateWithError(trust, nil) else { diagnostic.set(HostError("CERTIFICATE_INVALID", "电脑证书无效或过期，请在电脑更新证书后重新扫码")); completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
public actor HostConnection {
    private let session: URLSession
    private let trust: PinnedSession
    private let endpoint: URL
    private var token: String?
    private var socket: URLSessionWebSocketTask?
    private var generation = UUID()
    public init(address: String, fingerprint: String, token: String? = nil) throws {
        guard Invitation.validEndpoint(address), let url = URL(string: address), let host = url.host else { throw HostError("INVALID_ADDRESS", "电脑地址无效") }
        endpoint = url; self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 30
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        let trust = PinnedSession(fingerprint: fingerprint, hostname: host); self.trust = trust
        session = URLSession(configuration: configuration, delegate: trust, delegateQueue: nil)
    }
    public func setToken(_ token: String) { self.token = token }
    public func request(_ path: String, body: JSON? = nil, query: [String: String] = [:], authenticated: Bool = true) async throws -> JSON {
        var components = URLComponents(url: endpoint.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!); request.httpMethod = body == nil ? "GET" : "POST"
        if authenticated, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try body.data() }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { if let failure = trust.diagnostic.get() { throw failure }; throw error }
        guard let response = response as? HTTPURLResponse else { throw HostError("CONNECTION", "电脑响应无效", retryable: true) }
        let result = try JSON.decode(data)
        guard (200..<300).contains(response.statusCode) else { let e = result["error"]; throw HostError(e["code"].string, e["message"].string, retryable: e["retryable"].bool) }
        return result
    }
    public func command(_ type: String, _ payload: JSON, id: String = UUID().uuidString) async throws -> JSON {
        try await request("v1/command", body: .object(["version": .number(1), "kind": .string("command"), "id": .string(id), "type": .string(type), "payload": payload]))
    }
    public func openSocket(hostId: String, epoch: String) async throws {
        socket?.cancel(with: .goingAway, reason: nil); generation = UUID()
        var components = URLComponents(url: endpoint.appendingPathComponent("v1/ws"), resolvingAgainstBaseURL: false)!; components.scheme = "wss"
        var request = URLRequest(url: components.url!); if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let ws = session.webSocketTask(with: request); socket = ws; ws.maximumMessageSize = 2 * 1024 * 1024; ws.resume()
        let ready = try await receive()
        guard ready["version"].int == 1, ready["kind"].string == "ready", ready["hostId"].string == hostId, ready["storeEpoch"].string == epoch else { throw HostError("PROTOCOL_UNSUPPORTED", "电脑身份或协议发生变化，请重新连接") }
    }
    public func subscribe(_ room: String, after: Int, epoch: String) async throws {
        try await send(.object(["kind": .string("subscribe"), "roomId": .string(room), "afterSeq": .number(Double(after)), "storeEpoch": .string(epoch)]))
    }
    public func send(_ frame: JSON) async throws {
        guard let socket else { throw HostError("OFFLINE", "电脑未连接", retryable: true) }
        try await socket.send(.string(String(decoding: frame.data(), as: UTF8.self)))
    }
    public func receive() async throws -> JSON {
        let current = generation
        guard let socket else { throw HostError("OFFLINE", "电脑未连接", retryable: true) }
        let frame = try await socket.receive()
        guard current == generation else { throw CancellationError() }
        switch frame { case .data(let data): return try JSON.decode(data); case .string(let text): return try JSON.decode(Data(text.utf8)); @unknown default: throw HostError("PROTOCOL", "无法识别消息帧") }
    }
    public func close() { generation = UUID(); socket?.cancel(with: .goingAway, reason: nil); socket = nil; session.invalidateAndCancel() }
}
