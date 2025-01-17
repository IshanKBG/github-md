# github-md 

A markdown parser API for GitHub. SWR for 2 days with revalidation every 5 minutes.

Source: https://github.com/jacob-ebey/github-md

> You can change the URL when browsing github to to include `-md` for a preview of the rendered markdown

## Endpoints

### Parse Markdown

```text
/[username]/[repository]/[branch|tag|sha]/[filepath]
```

#### Response

- `attributes`: The attributes parsed off the front matter
- `html`: The HTML rendered from the markdown

#### Examples:

- https://github-md.com/remix-run/remix/main/docs/index.md
- https://github-md.com/facebook/react/17.0.2/README.md

### List Markdown Files

```text
/[username]/[repository]/[branch|tag|sha]
```

#### Response

- `sha`: The sha of the commit
- `files`: The list of files in the format of `{ path: string; sha: string }`

#### Examples:

- https://github-md.com/remix-run/remix/main
- https://github-md.com/facebook/react/17.0.2
