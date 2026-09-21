# Board direct execution

The Board run button must start a Task execution, not redirect to a conversation
Action. Scheduled task-chat definitions use fireTask even when Actions exist and
the schedule is paused. Once-only task-chat definitions still request fresh inputs
before launchWorkflow; external signals remain restricted to their source.
The button displays submission state and rejects duplicate clicks in flight.

Existing dynamic-rounds runner tests verify: initially planner only; planning
creates persisted Gate/role/link rows; release schedules dependencies; rework
adds another round; Gate never owns an Agent Run. No production task definition,
execution record, schedule or machine was changed to manufacture this result.
Static chains continue to create their real nodes at initialization.

Three focused runner/action tests and five mode/graph/replay tests pass.
Browser acceptance intercepts the mutation request; it must prove exactly one
fireTask, no compose event and navigation to the returned execution ID without
triggering a real Fleet retirement.

Deployed client only on active studio host 943f724c4f63, integration source 8f65ac5.
Fresh public Chrome verified one intercepted fireTask, zero conversation compose
events, navigation to returned batch ID and zero JS errors. It loaded heavy hash
203bca1343a99597c59cb62c15026ad6bf550da2fd9d0b6b8cc5415deec3411b.
This was an intercepted mutation acceptance, not a real retirement run.
No native boot-isolation fix or edge-cache Worker was deployed in this change.
