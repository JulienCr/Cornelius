import asyncio
import contextlib
import io
import json
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "perception"))
from browser_camera import BrowserCamera
from worker import Worker


class EventQueueTests(unittest.TestCase):
    def test_callback_queued_before_disconnect_does_not_reach_next_socket(self):
        worker = Worker.__new__(Worker)
        old, current = asyncio.Queue(), asyncio.Queue()
        worker.vision_queue = current
        worker._queue_put(old, {"type": "vision_status", "status": "ready"})
        self.assertTrue(old.empty())
        self.assertTrue(current.empty())
        worker._queue_put(current, {"type": "vision_status", "status": "ready"})
        self.assertEqual(current.qsize(), 1)
        worker.vision_queue = None
        worker._queue_put(current, {})
        self.assertEqual(current.qsize(), 1)


class InstalledModelTests(unittest.TestCase):
    def test_installation_reloads_the_same_model_on_the_existing_thread(self):
        worker = Worker.__new__(Worker)
        worker.vision_model = "1.6b"
        worker.vision_device = "auto"
        worker.scene = Mock()
        with patch("worker.SceneCaptioner") as captioner:
            worker.set_vision_model("1.6b")
            captioner.assert_not_called()
            worker.set_vision_model("1.6b", reload=True)
            captioner.assert_called_once()
            self.assertEqual(captioner.call_args.kwargs["device"], "auto")
            worker.scene.replace_captioner.assert_called_once_with(captioner.return_value)

    def test_device_change_reloads_the_same_model(self):
        worker = Worker.__new__(Worker)
        worker.vision_model = "3b"
        worker.vision_device = "auto"
        worker.scene = Mock()
        with patch("worker.SceneCaptioner") as captioner:
            worker.set_vision_model("3b", device="cpu")
            self.assertEqual(worker.vision_device, "cpu")
            self.assertEqual(captioner.call_args.kwargs["device"], "cpu")
            worker.scene.replace_captioner.assert_called_once_with(captioner.return_value)


class ObservationCadenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_processing_time_is_subtracted_without_catch_up_bursts(self):
        for elapsed, expected_wait in [(0.025, 0.075), (0.16, 0.0)]:
            with self.subTest(elapsed=elapsed):
                worker = Worker.__new__(Worker)
                worker.sequence = 0
                worker.enrollment = None
                worker.frame = Mock()
                frame = (1234, [], False, [], "ok", "camera")
                socket = Mock(send=AsyncMock())
                with patch("worker.asyncio.to_thread", new=AsyncMock(return_value=frame)), \
                     patch("worker.time.monotonic", side_effect=[10.0, 10.0 + elapsed]), \
                     patch("worker.asyncio.sleep", new=AsyncMock(side_effect=asyncio.CancelledError)) as sleep:
                    with self.assertRaises(asyncio.CancelledError):
                        await worker.observations(socket)
                self.assertAlmostEqual(sleep.call_args.args[0], expected_wait)
                socket.send.assert_awaited_once()
                self.assertEqual(worker.sequence, 1)


class VisionQuestionCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_tracking_duration_updates_before_and_after_camera_activation(self):
        worker = Worker.__new__(Worker)
        worker.vision = None
        class Socket:
            async def __aiter__(self):
                yield json.dumps({"type": "tracking", "graceMs": 15000})
        await worker.commands(Socket())
        self.assertEqual(worker.tracking_grace_ms, 15000)
        worker.vision = Mock()
        await worker.commands(Socket())
        worker.vision.configure_tracking.assert_called_once_with(15000)
        worker.vision.configure_identity_hold.assert_called_once_with(8000)
        class Settings:
            async def __aiter__(self):
                yield json.dumps({"type": "tracking", "graceMs": 9000, "identityHoldMs": 3000})
        await worker.commands(Settings())
        self.assertEqual(worker.identity_hold_ms, 3000)
        worker.vision.configure_identity_hold.assert_called_with(3000)

    async def test_command_passes_the_question_to_the_inference_worker(self):
        worker = Worker.__new__(Worker)
        scene = Mock()
        worker.scene_worker = Mock(return_value=scene)
        class Socket:
            async def __aiter__(self):
                yield json.dumps({"type": "vision", "requestId": "cup", "trigger": "tool", "question": "De quelle couleur est ma tasse ?"})
                yield json.dumps({"type": "vision", "requestId": "opening", "trigger": "scene"})
        await worker.commands(Socket())
        self.assertEqual(scene.request.call_args_list[0].args, ("cup", "tool", "De quelle couleur est ma tasse ?"))
        self.assertEqual(scene.request.call_args_list[1].args, ("opening", "scene", None))


class CameraCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_camera_opening_never_blocks_speech_detection(self):
        import threading
        import time
        worker = Worker.__new__(Worker)
        worker.interaction = "conversation"
        worker.last_speech, worker.last_vad_sent = None, 0
        worker.vad = Mock()
        worker.vad.process.return_value = True
        worker.scene = None
        worker.camera_enabled = False
        opened = threading.Event()

        def slow_enable(preferred=None, mode=None):
            time.sleep(0.5)
            worker.camera_enabled = True
            opened.set()
            return {"type": "camera_status", "selectedId": "one", "devices": [], "error": None}

        worker.enable_camera = slow_enable
        sent = []
        speech_while_opening = []

        class Socket:
            async def send(self, value):
                sent.append(value)
                if isinstance(value, str) and '"vad"' in value:
                    speech_while_opening.append(not opened.is_set())

            async def __aiter__(self):
                yield json.dumps({"type": "camera_enabled", "enabled": True})
                for _ in range(3):
                    yield bytes(1024)
                    await asyncio.sleep(0.05)

        await worker.commands(Socket())
        # Le son est analysé pendant que la caméra s’ouvre encore.
        self.assertTrue(speech_while_opening and speech_while_opening[0])
        await asyncio.gather(*worker.camera_tasks)
        self.assertTrue(any('"camera_status"' in value for value in sent if isinstance(value, str)))
        self.assertTrue(worker.camera_enabled)

    async def test_failed_camera_job_does_not_break_a_source_switch(self):
        worker = Worker.__new__(Worker)
        worker.camera = Mock()
        worker.camera_enabled = False
        worker.scene = None
        worker.tracking_grace_ms = 8000
        worker.identity_hold_ms = 8000
        worker.vision = None
        worker.server_camera_index = 0
        worker.enable_camera = Mock(side_effect=RuntimeError("device busy"))
        sent = []

        class Socket:
            async def send(self, value):
                sent.append(json.loads(value))

            async def __aiter__(self):
                yield json.dumps({"type": "camera_enabled", "enabled": True})
                yield json.dumps({"type": "camera_source", "source": "browser"})
                yield json.dumps({"type": "tracking", "graceMs": 15000})

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            await worker.commands(Socket())
        self.assertIsInstance(worker.camera, BrowserCamera)
        self.assertIn({"type": "camera_source_status", "source": "browser"}, sent)
        self.assertEqual(worker.tracking_grace_ms, 15000, "the command loop kept running")
        self.assertIn("RuntimeError", output.getvalue())
        self.assertNotIn("device busy", output.getvalue())


if __name__ == "__main__":
    unittest.main()
