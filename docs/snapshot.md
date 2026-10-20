# Snapshot format (schema 1)

What `GetSnapshot` returns as JSON. The add-on builds it and the host passes
it through unchanged.

```json
{
  "schema": 1,
  "windows": [
    {
      "id": 1,
      "incognito": true,
      "tabs": [
        {
          "id": 12,
          "title": "GNOME - Wikipedia",
          "url": "https://en.wikipedia.org/wiki/GNOME",
          "groupId": 1792459477206018,
          "lastAccessed": 1792459094009,
          "icon": "5f1c0a3e9b7d42c8a06e1f2b3c4d5e6f",
          "active": true,
          "pinned": true,
          "audible": true,
          "muted": true,
          "discarded": true
        }
      ]
    }
  ],
  "groups": [
    {"id": 1792459477206018, "windowId": 1, "title": "Work", "color": "blue", "collapsed": true}
  ]
}
```

- Only normal browser windows are included. Tabs are in tab-strip order.
- Boolean fields are left out when false.
- `groupId` is `-1` for tabs outside a group. Group ids are larger than 32 bits.
- `url` is cut to 300 characters.
- Tabs hidden by other extensions (`tabs.hide()`) are left out.
- `color` is one of grey, blue, purple, cyan, green, yellow, orange, red, pink.
- `icon`, when present, names the tab's favicon file:
  `$XDG_RUNTIME_DIR/firefox-tabs/icons/<icon>.png`. It is a PNG of at most
  32×32 that the add-on re-encoded from the page's favicon, and is named by
  the first 128 bits of its SHA-256 in hex. The host writes the file before
  serving any snapshot that names it. It leaves out tabs whose favicon isn't
  converted yet (a new snapshot follows) or can't be read (`about:` pages,
  and favicons that aren't `data:` URIs). Files unused for 7 days are
  deleted when a host starts.
- Clients should ignore fields they don't know. A change that breaks
  existing clients increases `schema`.
