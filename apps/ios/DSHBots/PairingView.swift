import SwiftUI
import VisionKit
import AVFoundation
import CoreImage.CIFilterBuiltins
import DSHBotsCore

struct PairingView: View {
    @Bindable var repository: ChatRepository
    @State var input: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?
    private var invitation: Invitation? { try? Invitation.parse(input) }
    var body: some View {
        NavigationStack {
            Form {
                Section { VStack(spacing: 16) { WhaleAvatar(size: 84); Text("连接 DSH Bots").font(.title2.bold()); Text("在电脑 Bots 聊天中打开邀请，扫描二维码加入同一条聊天时间线。").foregroundStyle(DSHTheme.secondary).multilineTextAlignment(.center) }.frame(maxWidth: .infinity).padding(.vertical, 16) }
                Section {
                    Button("扫描邀请二维码", systemImage: "qrcode.viewfinder") { Task { let allowed = await AVCaptureDevice.requestAccess(for: .video); if allowed && DataScannerViewController.isSupported && DataScannerViewController.isAvailable { scanning = true } else { error = "相机不可用。可以在系统设置允许相机访问，或粘贴电脑上的完整邀请链接。" } } }
                    TextField("粘贴 dshbots:// 邀请链接", text: $input, axis: .vertical).lineLimit(2...5).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    TextField("你的显示名称", text: $name).textContentType(.nickname)
                }
                if let invitation {
                    Section("加入前确认") {
                        Text("加入后可查看该聊天的完整历史，并调用其中已授权的助理。").font(.subheadline)
                        Text("电脑：" + invitation.hostId).font(.caption).textSelection(.enabled)
                        Text("证书 SHA-256：" + invitation.fingerprint).font(.caption2).textSelection(.enabled)
                        Text("仅扫描可信电脑展示的邀请。").font(.caption).foregroundStyle(DSHTheme.secondary)
                    }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                Button(busy ? "正在连接…" : "信任这台电脑并加入聊天") {
                    busy = true; error = nil
                    Task { do { try await repository.join(input, name: name, deviceName: UIDevice.current.name); dismiss() } catch { self.error = error.localizedDescription }; busy = false }
                }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || input.isEmpty)
            }.navigationTitle("扫描邀请").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) } }
                .sheet(isPresented: $scanning) { ScannerView(scanned: { value in input = value; scanning = false }, failed: { message in scanning = false; error = message }).ignoresSafeArea().overlay(alignment: .bottom) { Button("取消扫描") { scanning = false }.buttonStyle(.borderedProminent).padding(40) } }
                .onAppear { name = repository.bootstrap["person"]["displayName"].string }
        }
    }
}
struct ScannerView: UIViewControllerRepresentable {
    let scanned: (String) -> Void
    let failed: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned, failed) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let view = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
        view.delegate = context.coordinator
        do { try view.startScanning() } catch { let message = error.localizedDescription; Task { @MainActor in context.coordinator.failed(message) } }
        return view
    }
    func updateUIViewController(_ view: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ view: DataScannerViewController, coordinator: Coordinator) { view.stopScanning(); view.delegate = nil }
    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let scanned: (String) -> Void
        var finished = false
        let failed: (String) -> Void
        init(_ scanned: @escaping (String) -> Void, _ failed: @escaping (String) -> Void) { self.scanned = scanned; self.failed = failed }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { failed("相机暂不可用，请粘贴邀请链接。") }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !finished else { return }
            for item in addedItems { if case .barcode(let barcode) = item, let value = barcode.payloadStringValue { finished = true; dataScanner.stopScanning(); scanned(value); break } }
        }
    }
}
struct InviteView: View {
    let ticket: JSON
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { VStack(spacing: 20) {
            Text("邀请加入聊天").font(.title2.bold())
            if let image = qr(ticket["uri"].string) { Image(uiImage: image).interpolation(.none).resizable().scaledToFit().padding(16).background(.white).frame(maxWidth: 320).accessibilityLabel("聊天邀请二维码") }
            Text("新成员加入后可查看完整聊天历史。").foregroundStyle(DSHTheme.secondary)
            if let expiry = wireDate(ticket["expiresAt"].string) { Text("有效期至 \(expiry.formatted(date: .omitted, time: .shortened))").font(.caption) }
            ShareLink("分享邀请链接", item: ticket["uri"].string).buttonStyle(.borderedProminent)
            Spacer()
        }.padding(24).toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } } }
    }
    private func qr(_ value: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(value.utf8)
        guard let output = filter.outputImage, let cg = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 7, y: 7)), from: output.extent.applying(CGAffineTransform(scaleX: 7, y: 7))) else { return nil }; return UIImage(cgImage: cg)
    }
}
