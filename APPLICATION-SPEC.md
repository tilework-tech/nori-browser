Playwright is a powerful tool for scripting browsers. It is also a great defacto way for agents to interact with the web.

When an agent runs playwright in interactive mode, it can work alongside a user to do all sorts of interesting operations on the browser.

A pattern that I have developed recently is to run chrome in interactive mode through an agent -- most often, claude code through the nori cli. Then, when there is something I want the agent to do, I will tab back to the claude code nori cli and ask it to do things there. This includes:
- browser automation
- debugging
- network intercepting
and more.

I want to make this a fully fledged app that replaces my default chrome.

Specifically, I want the user flow to look something like this:
- when I click this app in my application sidebar, it spins up a nori cli claude code instance in a terminal
- it opens playwright-chrome, which I can use however I want
- additionally, there is a sidebar on the left side that is a simple pass through window to the terminal
- anything I type into the window gets routed to the claude code instance, and vice versa
- the claude code instance should have full access to the playwright chrome implementation

Build this out. The most important piece: you have to additionally build a test harness that verifies it works the way I described above.

It does not have to use nori cli if that is too complicated. You can find the code for the nori cli at ~/code/nori/nori-cli if that helps.
I just like the nori-cli because it has built in acp integration and a bunch of other nice features.

For verification, you should have a complete e2e test. The current one may not suffice, so validate that it does.

An actual e2e test would be:
  - start the app
  - confirm that the webbrowser loads
  - confirm that the nori session loads
  - ask nori to modify the webbrowser in some way
  - confirm the html in the webpage actually is modified'

The system should itself be fully scriptable. The nori browser should expose endpoints (or some other method of driving the application) so an agent can fully test and verify that the system is working as expected.

Note: the nori cli driving the playwright instance should NOT be using an MCP or tools. Instead, the agent should be given instructions on:
- how to access the browser
- told explicitly to script requests to the browser instead of relying on mcp tool calls and the like
- everything should be done by scripting the browser
