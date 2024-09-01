# ffigen

C header binding generator for modern JS environments. It works in combination with `c2ffi`.

## Usage

```
deno install jsr:@divy/ffigen
```

Install [`c2ffi`](https://github.com/rpav/c2ffi)

```
$ c2ffi ./include/Xlib.h | ffigen -l libXlib.so

$ deno run --allow-ffi ./Xlib.ts
```
