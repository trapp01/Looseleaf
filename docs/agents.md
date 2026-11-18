# Working with an AI agent

Looseleaf's server answers AI assistants at an MCP endpoint, `POST /mcp`. An
agent connected to it can search and read the notes, add to them, and keep a
notebook's board up to date while it works. What it changes shows in every
open client at once. The tools are listed in
[architecture.md](architecture.md#mcp-endpoint).

## Connect

Claude Code:

```sh
claude mcp add --transport http --scope user looseleaf http://<your-server>:8421/mcp \
  --header "Authorization: Bearer <token>"
```

The token is the server's access token: the one printed at first start and
kept in `data/token`. Any MCP client that can send that header to that address
works the same way. The tools that read notes (`list_notebooks`, `list_pages`,
`search_notes`, `read_page`) need the server's mirror on, which is the
default; the board tools and the write tools work with it off.

## What the agent is told

The server sends these instructions to every agent that connects, so nothing
has to be configured for an agent to behave:

1. Before starting a task, find its card (`search_cards`, or the ref the
   person gave, such as `HOME-12`) and read it in full with `get_card`. When
   no card exists, make one with `create_card`, with a description someone
   with no other context could pick up. Then move it to a status of kind
   `doing`.
2. When the person is planning work rather than starting it, make the card
   then, in a `todo` status, with what is wanted, why, and what was decided.
   A card is a page, so anything longer goes on that page with
   `append_to_page`.
3. While working, tick the card's checklist (the To Do lines on its page)
   with `update_checklist` as each is finished, comment when there is a
   finding, a decision or a blocker, and link branches and pull requests with
   `add_link`.
4. When stopping, comment with what was done, what is left and how to check
   it, and move the card to a `done` status when it is finished.
5. Something ruled out of scope or wanted later becomes its own card in a
   `todo` status. A To Do line in the board's Inbox can become that card with
   `create_card` and the line's id.
6. Change only the cards the task is about, and archive only when asked.
7. A subagent doing one piece of another agent's task reads cards when they
   help and changes none; the agent that handed out the piece owns the card.

## Making it a habit in a project

The instructions above are a default. To make a project's agents start from
the board every time, add something like this to the project's agent
instructions (`CLAUDE.md`, `AGENTS.md`):

```markdown
## Task board

Tasks for this project are on the Looseleaf board with the key WEB (MCP
server `looseleaf`).

- Before starting any task, find its card or create one, read it with
  get_card, and move it to In progress.
- Work the card's checklist; tick items as they are finished.
- When you stop, comment on the card with what was done, what is left and how
  to verify it. Move it to Done only when it is finished and verified.
- Anything I say is out of scope or for later goes on the board as a new card
  in Backlog with the label of the app it touches.
```

## What a card gives an agent

A card is a page in the board's notebook. `get_card` answers with the whole
card as Markdown: where it stands, its labels and due day, the page itself,
its To Do lines as the checklist with each line's id, links, comments and
activity. The id it prints is the page id, which `read_page` and
`append_to_page` take as well as the ref.

A person's side of that bargain is the page. A card whose page says what is
wanted, why, and how to tell it is finished lets an agent start without a
conversation. Notes, scopes and loose thoughts live on the same server, so an
agent can read a scope page, make a card per piece of work, and link each card
back to the page.

## Statuses and kinds

A board's statuses are its columns, and they can be called anything. Each has
a **kind**: `todo`, `doing` or `done`. Agents can name a status by its kind,
so "move it to doing" works on a board whose column is called "In progress",
"Building" or "On the bench". Set a status's kind from its menu in the web
client.

## What an agent cannot do

No tool deletes a card, a status, a board or a To Do line, and none rewrites
text already in a page: `append_to_page` adds after the end, `update_card`
changes a title, due day or labels, and archiving is the one way off a board.
The one change to existing text is turning an Inbox line into a card, which
replaces the line with a card link to the new card.
Whatever an agent does can be put back from the web client.

A prompt that turns a scope into cards:

> Read my page "Checkout rework scope". For each piece of work in it, create
> a card on the WEB board in Backlog with the label for the app it touches, a
> description I could hand to someone else, and a link back to the page. Put
> anything the page calls out of scope in one card titled "Checkout rework:
> later". Then show me the board.
