# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden
demo server and tests. None of it is a publisher default file, and the
player ids in the lists are made up.

- dialwarden-args.txt: one launch line with a double-quoted name (the
  quoting the launch adapter writes, so every value restores byte for
  byte), a public server, the -preset flag in front of the -modifier
  flags it must precede, and two-token -modifier arguments (THE-2582).
- adminlist.txt: a plain LF list file with only its comment header.
- bannedlist.txt: a plain LF list file with only its comment header.
- permittedlist.txt: a list file with a UTF-8 BOM and CRLF line ends,
  the shape the game itself writes (THE-2582).
