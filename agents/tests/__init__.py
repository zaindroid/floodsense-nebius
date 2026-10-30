# Existing tests assume the Nightshift lane names; the product default is nebius.
import os

os.environ.setdefault("LLM_BACKEND", "nightshift")
