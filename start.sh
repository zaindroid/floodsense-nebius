#!/bin/sh
# Three processes, one container, started innermost first.
#
# The engines are a side channel: every call to them is wrapped and a run
# that cannot reach them carries on with a trace note, so they are started
# and not waited for. The agents are not optional -- the API answers 503
# without them -- but they are given their own interpreter because a graph
# run is synchronous and long. The server at the front is the process this
# container lives or dies by.
set -eu

node --experimental-transform-types --no-warnings /engines/src/main.ts &

python -m floodsense_agents &

exec python -m serve
