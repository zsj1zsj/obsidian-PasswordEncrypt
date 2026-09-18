# reedsolomon.ts

TypeScript port of [cho45/reedsolomon.js](https://github.com/cho45/reedsolomon.js), which is itself a port of [ZXing's Reed-Solomon codec](https://github.com/zxing/zxing/tree/master/core/src/main/java/com/google/zxing/common/reedsolomon).

Reed-Solomon error correction encoding and decoding over GF(2^8). Zero dependencies.

## Install

```bash
npm install reedsolomon.ts
```

## Usage

```typescript
import {
    RS_Encoder,
    RS_Decoder,
    GF_DATA_MATRIX_256,
} from 'reedsolomon.ts';

const field = GF_DATA_MATRIX_256();
const encoder = new RS_Encoder(field);
const decoder = new RS_Decoder(field);

// message = 24 data bytes + 8 parity bytes = 32 total
const message = new Int32Array(32);
for (let i = 0; i < 24; i++) message[i] = i;

// Encode: parity bytes are written to positions [24, 32)
encoder.encode(message, 8);

// Corrupt up to 4 bytes (8 parity bytes / 2 = 4 correctable errors)
message[5] = 0xff;
message[10] = 0xff;
message[20] = 0xff;
message[30] = 0xff;

// Decode: corrects errors in-place
decoder.decode(message, 8);
// message[0..24] is restored to original data
```

## API

### `GF_DATA_MATRIX_256()`

Returns a `Generic_GF` field for GF(2^8) with primitive polynomial x^8 + x^5 + x^3 + x^2 + 1 (`0x012D`), generator base 1. Used by Data Matrix and Aztec codes.

### `GF_QR_CODE_256()`

Returns a `Generic_GF` field for GF(2^8) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (`0x011D`), generator base 0. Used by QR codes.

### `new RS_Encoder(field)`

Creates an encoder for the given Galois field.

#### `encoder.encode(data: Int32Array, ec_bytes: number): void`

Encodes in-place. `data` must have length = data bytes + `ec_bytes`. Data occupies positions `[0, data_bytes)` and parity is written to `[data_bytes, length)`.

### `new RS_Decoder(field)`

Creates a decoder for the given Galois field.

#### `decoder.decode(received: Int32Array, ec_bytes: number): void`

Decodes (corrects errors) in-place. Can correct up to `ec_bytes / 2` byte errors. Throws if errors exceed correction capacity.

### `Generic_GF`

Galois field implementation. Use the factory functions above unless you need a custom field.

#### `new Generic_GF(primitive: number, size: number, generator_base: number)`

Creates a custom Galois field with the given primitive polynomial, size, and generator base.

## License

Apache-2.0. See [LICENSE](https://www.apache.org/licenses/LICENSE-2.0).

Original Java implementation: Copyright 2007 ZXing authors.
JavaScript port: cho45. TypeScript port: ecartz.
