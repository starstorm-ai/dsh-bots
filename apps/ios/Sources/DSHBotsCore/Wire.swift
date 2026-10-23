import Foundation

/// Lossless public JSON boundary. Unknown protocol fields survive cache round trips.
public enum JSON: Codable, Sendable, Equatable, Identifiable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let x = try? c.decode(Bool.self) { self = .bool(x) }
        else if let x = try? c.decode(String.self) { self = .string(x) }
        else if let x = try? c.decode(Double.self) { self = .number(x) }
        else if let x = try? c.decode([JSON].self) { self = .array(x) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .object(let x): try c.encode(x); case .array(let x): try c.encode(x); case .string(let x): try c.encode(x); case .number(let x): try c.encode(x); case .bool(let x): try c.encode(x); case .null: try c.encodeNil() }
    }
    public subscript(_ key: String) -> JSON {
        get { if case .object(let x) = self { return x[key] ?? .null }; return .null }
        set { var x = object; x[key] = newValue; self = .object(x) }
    }
    public var object: [String: JSON] { if case .object(let x) = self { x } else { [:] } }
    public var array: [JSON] { if case .array(let x) = self { x } else { [] } }
    public var string: String { if case .string(let x) = self { x } else { "" } }
    public var int: Int { if case .number(let x) = self, x.isFinite, x >= Double(Int.min), x < Double(Int.max) { Int(x) } else { 0 } }
    public var bool: Bool { if case .bool(let x) = self { x } else { false } }
    public var id: String { self["id"].string }
    public func data() throws -> Data { try JSONEncoder().encode(self) }
    public static func decode(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
    public static func strings(_ values: [String]) -> JSON { .array(values.map(JSON.string)) }
}
public struct HostError: Error, LocalizedError, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public init(_ code: String, _ message: String, retryable: Bool = false) { self.code = code; self.message = message; self.retryable = retryable }
    public var errorDescription: String? { message }
}
public struct Invitation: Codable, Sendable {
    public let protocolVersion: Int
    public let kind: String
    public let hostId: String
    public let storeEpoch: String
    public let addresses: [String]
    public let fingerprint: String
    public let token: String
    public let expiresAt: String
    public let roomId: String
    public let historyVisibility: String
    enum CodingKeys: String, CodingKey { case protocolVersion = "protocol", kind, hostId, storeEpoch, addresses, fingerprint, token, expiresAt, roomId, historyVisibility }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try c.decode(Int.self, forKey: .protocolVersion); kind = try c.decode(String.self, forKey: .kind)
        hostId = try c.decode(String.self, forKey: .hostId); storeEpoch = try c.decode(String.self, forKey: .storeEpoch)
        addresses = try c.decode([String].self, forKey: .addresses); fingerprint = try c.decode(String.self, forKey: .fingerprint)
        token = try c.decode(String.self, forKey: .token); expiresAt = try c.decode(String.self, forKey: .expiresAt)
        roomId = try c.decodeIfPresent(String.self, forKey: .roomId) ?? ""; historyVisibility = try c.decodeIfPresent(String.self, forKey: .historyVisibility) ?? ""
    }
    public static func parse(_ input: String, now: Date = Date()) throws -> Invitation {
        guard input.utf8.count <= 65536 else { throw HostError("INVALID_INVITE", "邀请二维码过大") }
        var urlKind: String?
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("dshbots:") {
            guard let url = URLComponents(string: value), url.host == "invite", let data = url.queryItems?.first(where: { $0.name == "data" })?.value else { throw HostError("INVALID_INVITE", "无法识别邀请链接") }
            urlKind = url.host; value = data
        }
        let invite = try JSONDecoder().decode(Self.self, from: Data(value.utf8))
        guard invite.protocolVersion == 1 else { throw HostError("PROTOCOL_UNSUPPORTED", "请升级 App 以支持此电脑的协议") }
        guard invite.kind == "invite", urlKind == nil || urlKind == invite.kind, invite.historyVisibility == "full", !invite.roomId.isEmpty, !invite.hostId.isEmpty, !invite.storeEpoch.isEmpty, !invite.token.isEmpty,
              invite.fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              !invite.addresses.isEmpty, invite.addresses.count <= 32,
              invite.addresses.allSatisfy(validEndpoint) else { throw HostError("INVALID_INVITE", "邀请的身份或地址无效") }
        guard let expiry = wireDate(invite.expiresAt), expiry > now else { throw HostError("INVITE_EXPIRED", "邀请已过期，请在电脑上生成新邀请") }
        return invite
    }
    public static func validEndpoint(_ value: String) -> Bool {
        guard let u = URLComponents(string: value), u.scheme == "https", let host = u.host, !host.isEmpty,
              u.user == nil, u.password == nil, u.query == nil, u.fragment == nil, u.path.isEmpty || u.path == "/" else { return false }
        return u.port == nil || (1...65535).contains(u.port!)
    }
}
public func wireDate(_ text: String) -> Date? {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}
public struct TrustedHost: Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var addresses: [String]
    public var fingerprint: String
    public var credentials: JSON
    public var scope: String { [id, credentials["principal"]["personId"].string, credentials["storeEpoch"].string].joined(separator: ":") }
    public init(id: String, name: String, addresses: [String], fingerprint: String, credentials: JSON) { self.id = id; self.name = name; self.addresses = addresses; self.fingerprint = fingerprint; self.credentials = credentials }
}
public let activeStatuses: Set<String> = ["queued", "dispatching", "accepted", "running", "waiting_user"]
public func mergeMessages(_ current: [JSON], _ incoming: [JSON]) -> [JSON] {
    var map: [String: JSON] = [:]; for x in current + incoming { map[x.id] = x }
    return map.values.sorted { $0["seq"].int == $1["seq"].int ? $0.id < $1.id : $0["seq"].int < $1["seq"].int }
}
public func displayedText(_ message: JSON) -> String {
    let parts = message["parts"].array.map { $0["type"].string == "mention" ? "@\($0["label"].string) " : $0["text"].string }.joined()
    return parts.isEmpty ? message["text"].string : parts
}
