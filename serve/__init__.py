"""One origin for the FloodSense console.

The team's stack is four services under Compose. This repository is the
deploy mirror of main and runs the same four in one container, because the
platform gives an app one port:

    engines  127.0.0.1:8300   H-MEM and the World Model (no auth, loopback)
    agents   127.0.0.1:8100   the LangGraph service
    api      in this process  the proxy, mounted under /api
    ui       in this process  the built bundle, served at /

Keeping the API in this process rather than a fourth uvicorn saves a whole
interpreter, and the browser sees one origin, so the Compose stack's CORS
question does not arise here at all. The agents stay a process of their own:
a graph run is synchronous and long, and it belongs in its own event loop.
"""
