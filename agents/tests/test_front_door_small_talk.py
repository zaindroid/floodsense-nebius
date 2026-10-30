import unittest

from floodsense_agents import front_door


class _FailingLLM:
    def complete(self, *a, **k):
        raise RuntimeError("rate limited")


class SmallTalkTest(unittest.TestCase):
    def test_greeting_with_small_talk_is_a_reply(self):
        for q in (
            "Hello, how are you FloodSense?",
            "hi, how's it going?",
            "Hola, ¿qué tal?",
            "Hallo, wie geht's?",
            "hey there, what's up",
        ):
            self.assertEqual(front_door.rules(q), ("greeting", True), q)

    def test_flood_words_still_win(self):
        self.assertEqual(front_door.rules("Hello, how is the Rhine?")[0], "flood_question")

    def test_long_or_placed_text_still_runs(self):
        self.assertEqual(front_door.classify("what about Bonn", _FailingLLM())[0], "flood_question")


if __name__ == "__main__":
    unittest.main()
