# @junjo.io/shared

## 0.2.0

### Minor Changes

- 1902ebe: Contract updates shared by the server and SDKs.

  - New friends contract types: friendships, friend requests, blocks, friend tags, suggestions, and per-user visibility settings.
  - Canonical `JUNJO_ERROR_CODES` list and `JunjoErrorCode` union; the server's error factory and the SDK's `JunjoError.code` are both typed against it.
  - Removed the dead `WebhookDelivery` type.
  - Corrected package `exports` for dual-format consumers and declared `engines` (Node >= 20).
