// Build the text watermark from its native layout; no runtime fonts are needed.
import AppKit
let label = "山地造物 · 免费版"
let font = NSFont(name: "Heiti SC", size: 44) ?? NSFont.systemFont(ofSize: 44)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white.withAlphaComponent(0.85)]
let text = label as NSString
let measured = text.size(withAttributes: attrs)
let padding: CGFloat = 10
let size = NSSize(width: ceil(measured.width) + 2 * padding, height: ceil(measured.height) + 12)
let image = NSImage(size: size)
image.lockFocus()
let rect = NSRect(x: 0.5, y: 0.5, width: size.width - 1, height: size.height - 1)
let box = NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10)
NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.13, alpha: 0.60).setFill(); box.fill()
NSColor.white.withAlphaComponent(0.4).setStroke(); box.lineWidth = 1; box.stroke()
text.draw(at: NSPoint(x: padding, y: (size.height - measured.height) / 2), withAttributes: attrs)
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
let png = bitmap.representation(using: .png, properties: [:])!
let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/free-watermark.png"
try png.write(to: URL(fileURLWithPath: target))
print("Watermark layout: \(Int(size.width)) × \(Int(size.height)), equal 10px horizontal padding")
