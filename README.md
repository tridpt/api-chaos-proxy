# ⚡ ChaosForge v2.0 — Trạm Thử Thách Độ Bền Frontend (API Chaos Proxy)

Local Reverse Proxy nằm giữa Frontend và Backend (**Cockpit `:4190`** · **Gateway `:4191`**) để kiểm thử khả năng chịu lỗi thực chiến:

- Giả lập mạng chậm 3G, lỗi HTTP `500`/`429`, đột biến cấu trúc JSON.
- Khựng hoặc ngắt giữa chừng luồng **AI Streaming SSE** & **WebSocket**.
- Bẫy **401 Refresh Token Race**, **GraphQL Partial Error** và Breakpoint sửa gói tin trực tiếp.
- Nhập/xuất Chrome `.HAR`, tự động suy luận **OpenAPI 3.0**, kịch bản **GameDay Timeline** & nhúng **Floating HUD** 1 dòng.

## Khởi chạy nhanh

```bash
node server.js
# Cockpit UI: http://127.0.0.1:4190
# Reverse Proxy Gateway: http://127.0.0.1:4191
```

## Kiểm thử

```bash
npm test
```

