const r = /^(?:open|launch|start|run|show|execute)\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:and\s+then|then|and)\s+|,\s*)(.+)$/i;
console.log(r.test("open Notepad, type 'hi user', and then minimize the window"));
console.log(r.test("open note pad and then type hi user and then minimize"));
