import unittest

from feishu_cursor_remote.main import parse_command, parse_content, parse_message, trim_reply


class ParsingTests(unittest.TestCase):
    def test_parse_text_content(self) -> None:
        self.assertEqual(parse_content('{"text":"/status"}'), "/status")

    def test_parse_plain_content(self) -> None:
        self.assertEqual(parse_content("/status"), "/status")

    def test_parse_command_ignores_regular_chat(self) -> None:
        self.assertIsNone(parse_command("hello"))

    def test_parse_command_keeps_quoted_question(self) -> None:
        self.assertEqual(
            parse_command('/ask app "why did tests fail?"'),
            ["/ask", "app", "why did tests fail?"],
        )

    def test_parse_flat_event(self) -> None:
        message = parse_message(
            {
                "message_id": "om_1",
                "chat_id": "oc_1",
                "chat_type": "p2p",
                "sender_id": "ou_1",
                "content": '{"text":"/status"}',
            }
        )
        self.assertIsNotNone(message)
        assert message is not None
        self.assertEqual(message.text, "/status")
        self.assertEqual(message.chat_type, "p2p")

    def test_parse_nested_lark_event(self) -> None:
        message = parse_message(
            {
                "event": {
                    "message": {
                        "message_id": "om_1",
                        "chat_id": "oc_1",
                        "chat_type": "group",
                        "content": '{"text":"/status"}',
                    },
                    "sender": {"sender_id": {"open_id": "ou_1"}},
                }
            }
        )
        self.assertIsNotNone(message)
        assert message is not None
        self.assertEqual(message.chat_type, "group")

    def test_trim_reply(self) -> None:
        self.assertIn("truncated locally", trim_reply("x" * 100, 40))


if __name__ == "__main__":
    unittest.main()

