"""Smoke test run in a child process: exit 0 only if the ONNX Runtime provider registers.

Usage: python -I provider_probe.py <ProviderName>. A native crash in a GPU driver
stack kills this child instead of the perception worker.
"""

import sys


def _field(number, wire, payload):
    return bytes([number << 3 | wire]) + payload


def _bytes(number, data):
    return _field(number, 2, bytes([len(data)]) + data)


def identity_model():
    """Serialized ONNX model with a single Identity node (no onnx package needed)."""
    dim = _bytes(1, _field(1, 0, b"\x01"))
    tensor = _field(1, 0, b"\x01") + _bytes(2, dim)
    info = lambda name: _bytes(1, name) + _bytes(2, _bytes(1, tensor))
    node = _bytes(1, b"x") + _bytes(2, b"y") + _bytes(4, b"Identity")
    graph = _bytes(1, node) + _bytes(2, b"probe") + _bytes(11, info(b"x")) + _bytes(12, info(b"y"))
    return _field(1, 0, b"\x08") + _bytes(7, graph) + _bytes(8, _field(2, 0, b"\x0d"))


def main(provider):
    import onnxruntime as ort

    if provider == "CUDAExecutionProvider" and hasattr(ort, "preload_dlls"):
        ort.preload_dlls()
    session = ort.InferenceSession(identity_model(), providers=list(dict.fromkeys([provider, "CPUExecutionProvider"])))
    return 0 if provider in session.get_providers() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
