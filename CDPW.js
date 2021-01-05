"use strict";
/* eslint-disable consistent-this */

const XU = require("@sembiance/xu"),
	runUtil = require("@sembiance/xutil").run,
	netUtil = require("@sembiance/xutil").net,
	tiptoe = require("tiptoe"),
	fs = require("fs"),
	fileUtil = require("@sembiance/xutil").file,
	util = require("util"),		// eslint-disable-line no-unused-vars
	cdp = require("chrome-remote-interface");

// Chrome DevTools Protocol API: https://chromedevtools.github.io/devtools-protocol/tot/Input
// Chrome command line flags: https://peter.sh/experiments/chromium-command-line-switches/

(function _CDPW()
{
	class CDPW
	{
		constructor(_headless, cb)
		{
			const cdpw=this;
			cdpw.eventListeners = {};
			cdpw.headless = !!_headless;
			cdpw.debugPort = Math.randomInt(5001, 32000);

			cdpw.userDataDir = fileUtil.generateTempFilePath(undefined, "cdpw-user-dir");

			tiptoe(
				function makeUserDataDir()
				{
					fs.mkdir(cdpw.userDataDir, this);
				},
				function launchChrome()
				{
					const chromeLaunchArgs = [`--user-data-dir=${cdpw.userDataDir}`, "--disable-infobars", "--disable-notifications", "--disable-suggestions-ui", "--disable-default-apps", "--disable-extensions", "--disable-sync", "--enable-automation"];
					if(cdpw.headless)
						chromeLaunchArgs.push("--headless", "--hide-scrollbars", "--disable-gpu", "--window-size=1200,960");
					chromeLaunchArgs.push("--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpw.debugPort}`);
				
					cdpw.cp = runUtil.run("chromium", chromeLaunchArgs, {silent : true, detached : true, env : { DISPLAY : ":0" }});
					cdpw.cp.on("error", this);
					netUtil.waitForConnection("127.0.0.1", cdpw.debugPort, this);
				},
				function createCDP()
				{
					cdp({host : "127.0.0.1", port : cdpw.debugPort}, client => this(undefined, client)).on("error", this);
				},
				function returnResult(err, client)
				{
					if(err)
						return cb(err);
					
					cdpw.client = client;
					cdpw.client.on("event", cdpw.eventHandler.bind(cdpw));
					cb(undefined, client);
				}
			);
		}

		// Opens the given url with the given options
		open(_options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb, {width : (this.headless ? 1200 : 0), height : (this.headless ? 960 : 0)});

			const deviceMetrics = {
				deviceScaleFactor : 0,
				mobile            : false,
				fitWindow         : false
			};

			deviceMetrics.width = options.width;
			deviceMetrics.height = options.height;

			const cdpw = this;

			tiptoe(
				function enableParts()
				{
					cdpw.client.Page.enable(this.parallel());
					cdpw.client.DOM.enable(this.parallel());
					cdpw.client.Network.enable(this.parallel());
					cdpw.client.Runtime.enable(this.parallel());
				},
				function setDeviceMetrics()
				{
					cdpw.client.Emulation.setDeviceMetricsOverride(deviceMetrics, this);
				},
				function setVisibleSize()
				{
					if(deviceMetrics.width && deviceMetrics.height)
						cdpw.client.Emulation.setVisibleSize({width : deviceMetrics.width, height : deviceMetrics.height}, this);
					else
						this();
				},
				cb
			);
		}

		// Navigate to the given page
		navigate(url, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb, {delay : 0});

			const cdpw=this;

			tiptoe(
				function navigate()
				{
					cdpw.client.Page.navigate({url}, this);
				},
				function waitForPageToLoad()
				{
					const self=this;
					cdpw.client.Page.loadEventFired(() => setTimeout(self, options.delay));
				},
				function getDocument()
				{
					cdpw.client.DOM.getDocument(this);
				},
				function saveDocument(doc)
				{
					cdpw.document = doc;
					this();
				},
				cb
			);
		}

		// Used to instruct CDPW that the web page has changed to a different page
		webPageHasChanged(cb)
		{
			const cdpw=this;

			tiptoe(
				function getDocument()
				{
					cdpw.client.DOM.getDocument(this);
				},
				function saveDocument(doc)
				{
					cdpw.document = doc;
					this();
				},
				cb
			);
		}

		// Evaluates the given code and returns the result
		evaluate(expression, cb)
		{
			this.client.Runtime.evaluate({ expression }, (err, result) =>
			{
				if(err)
					return cb(err);
				
				if(!result)
					return cb(new Error("CDPW.evaluate: No result"));

				if(!result.result)
					return cb(new Error("CDPW.evaluate: No sub result"));

				if(!["number", "string", "boolean", "undefined"].includes(result.result.type))
				{
					//console.log(result);
					return cb(new Error(`CDPW.evaluate: Unsupported result type [${result.result.type}] for expression: ${expression}`));
				}

				cb(undefined, result.result.value);
			});
		}

		// Runs the passed in function fun continually until it calls it's subcb with a truthy second value or until timeout has passed
		wait(fun, timeout, cb)
		{
			const timeoutError = new Error(`CDPW.wait timed out (Screenshot written to /tmp/wait_failed_ss.png): ${fun.toString()}`);
			const timeoutid = setTimeout(() =>
			{
				this.client.Page.captureScreenshot({format : "png"}, (err, ss) =>
				{
					fs.writeFileSync("/tmp/wait_failed_ss.png", Buffer.from(ss.data, "base64"));
					cb(timeoutError);
				});
			}, timeout);

			function runFunc()
			{
				fun((err, ...results) =>
				{
					if(err || (results.length>=1 && results[0]))
						clearTimeout(timeoutid);

					if(err)
						return cb(err);

					if((results.length>=1 && results[0]))
						return cb(undefined, ...results);

					setImmediate(runFunc);
				});
			}
			
			runFunc();
		}

		// Returns true if the selector is visible, false otherwise
		isVisible(selector, cb)
		{
			this.evaluate(`window.getComputedStyle(document.querySelector("${selector.replaceAll('"', '\\"')}")).display!=="none"`, (suberr, r) => (suberr ? cb() : cb(undefined, r)));
		}

		// Returns true if the selector is NOT visible, false otherwise
		isNotVisible(selector, cb)
		{
			this.evaluate(`window.getComputedStyle(document.querySelector("${selector.replaceAll('"', '\\"')}")).display==="none"`, (suberr, r) => (suberr ? cb() : cb(undefined, r)));
		}

		// Runs the given selector on the document
		querySelector(selector, cb)
		{
			this.client.DOM.querySelector({nodeId : this.document.root.nodeId, selector}, (err, result) =>
			{
				if(err || !result || !result.nodeId)
					return cb([new Error(`Invalid selector: ${selector}`), result, err]);
					
				cb(undefined, result.nodeId);
			});
		}

		// Returns the text content of the given target
		getText(selector, cb)
		{
			this.evaluate(`document.querySelector("${selector.replaceAll('"', '\\"')}").innerText`, (suberr, r) => (suberr ? cb(suberr) : cb(undefined, r)));
		}

		// Returns the XY coordinate of the given target using client side getBoundingClientRect() which may be more accurate or different than the getBoxModel
		getXY(selector, _options, _cb)
		{
			// XY offset from top left for where to click. Integer values are absolute pixels, strings percentages are a percentage of the target's width and height.
			// Can pass in offset : null or offset: undefined to not specific an offset (then top left corner will be used)
			const {options, cb} = XU.optionscb(_options, _cb, {offset : ["50%", "50%"]});

			this.evaluate(`JSON.stringify(document.querySelector("${selector.replaceAll('"', '\\"')}").getBoundingClientRect())`, (err, rs) =>
			{
				if(err)
					return cb(err);

				const r = JSON.parse(rs);

				const xy = [r.x, r.y];
				if(options.offset)
				{
					const offsets = options.offset.map((v, i) => ((typeof v==="string" && v.endsWith("%")) ? (((+v.substring(v, v.length-1))/100)*r[(["width", "height"][i])]) : v));
					xy.mapInPlace((xory, i) => xory+offsets[i]);
				}

				cb(undefined, xy);
			});
		}

		// Returns the XY coordinate of the given selector. This uses getBoxModel() which can be wrong when things are rotated, using the client side version above is more reliable
		/*getXY(selector, _options, _cb)
		{
			// XY offset from top left for where to click. Integer values are absolute pixels, strings percentages are a percentage of the target's width and height.
			// Can pass in offset : null or offset: undefined to not specific an offset (then top left corner will be used)
			const {options, cb} = XU.optionscb(_options, _cb, {offset : ["50%", "50%"]});

			const cdpw=this;

			tiptoe(
				function getNode()
				{
					cdpw.querySelector(selector, this);
				},
				function getBoxModel(nodeId)
				{
					cdpw.client.DOM.getBoxModel({nodeId}, this);
				},
				function returnResults(err, r)
				{
					if(err)
						return cb(((err===true && r) ? (new Error("CDPW.getXY('" + selector + "') failed with: " + JSON.stringify(r))) : err));

					console.log(selector, util.inspect(r, {depth : 9, colors : true}));

					const xy = r.model.content.slice(0, 2);
					//xy[1] += (r.model.content[1]-r.model.margin[1]);

					if(options.offset)
					{
						const offsets = options.offset.map((v, i) => ((typeof v==="string" && v.endsWith("%")) ? (((+v.substring(v, v.length-1))/100)*r.model[(["width", "height"][i])]) : v));
						xy.mapInPlace((xory, i) => xory+offsets[i]);
					}
					
					cb(undefined, xy);
				}
			);
		}*/

		// Perform a mouse event on the given target (string selector, array of x/y coords or an integer nodeId)
		mouseEvent(target, type, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb, {button : "left"});

			const cdpw = this;

			tiptoe(
				function getXY()
				{
					if(Array.isArray(target))
						this(undefined, target);
					else
						cdpw.getXY(target, options, this);
				},
				function dispatchMouseEvent(xy)
				{
					const mouseEventOptions = {
						type,
						x          : xy[0],
						y          : xy[1],
						button     : options.button,
						clickCount : 1
					};

					cdpw.client.Input.dispatchMouseEvent(mouseEventOptions, this);
				},
				cb
			);
		}

		// Perform a mouseDown event on the given target (string selector, array of x/y coords or an integer nodeId)
		mouseDown(target, ...args)
		{
			this.mouseEvent(target, "mousePressed", ...args);
		}

		// Perform a mouseUp event on the given target (string selector, array of x/y coords or an integer nodeId)
		mouseUp(target, ...args)
		{
			this.mouseEvent(target, "mouseReleased", ...args);
		}

		// Perform a mouseMove event on the given target (string selector, array of x/y coords or an integer nodeId)
		mouseMove(target, ...args)
		{
			this.mouseEvent(target, "mouseMoved", ...args);
		}

		// Drag the given dragTarget over to the dropTarget
		dnd(dragTarget, dropTarget, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb);

			const cdpw=this;

			tiptoe(
				function moveToDrag()	{ cdpw.mouseMove(dragTarget, options, this); },
				function pressMouse()	{ cdpw.mouseDown(dragTarget, options, this); },
				function delayMove() 	{ setTimeout(this, 50); },
				function moveToDrop()	{ cdpw.mouseMove(dropTarget, options, this); },
				function delayDrop() 	{ setTimeout(this, 50); },
				function releaseMouse()	{ cdpw.mouseUp(dropTarget, options, this); },
				cb
			);
		}

		// Presses a single key on the keyboard
		pressKey(c, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb);

			const cdpw=this;

			// Keys came from: https://github.com/chromedp/chromedp/blob/master/kb/keys.go
			const KEYMAP =
			{
				"Backspace" : ["Backspace", "Backspace", "", "", 8, 8, false, false],
				"Tab"       : ["Tab", "Tab", "", "", 9, 9, false, false],
				"Enter"     : ["Enter", "Enter", "\r", "\r", 13, 13, false, true],
				"Escape"    : ["Escape", "Escape", "", "", 27, 27, false, false],
				"Delete"    : ["Delete", "Delete", "", "", 46, 46, false, false],
				"Pause"     : ["Pause", "Pause", "", "", 19, 19, false, false],
				" "   : ["Space", " ", " ", " ", 32, 32, false, true],
				"!"   : ["Digit1", "!", "!", "1", 49, 49, true, true],
				'"'   : ["Quote", "\"", "\"", "'", 222, 222, true, true],
				"#"   : ["Digit3", "#", "#", "3", 51, 51, true, true],
				"$"   : ["Digit4", "$", "$", "4", 52, 52, true, true],
				"%"   : ["Digit5", "%", "%", "5", 53, 53, true, true],
				"&"   : ["Digit7", "&", "&", "7", 55, 55, true, true],
				"'"   : ["Quote", "'", "'", "'", 222, 222, false, true],
				"("   : ["Digit9", "(", "(", "9", 57, 57, true, true],
				")"   : ["Digit0", ")", ")", "0", 48, 48, true, true],
				"*"   : ["Digit8", "*", "*", "8", 56, 56, true, true],
				"+"   : ["Equal", "+", "+", "=", 187, 187, true, true],
				","   : ["Comma", ",", ",", ",", 188, 188, false, true],
				"-"   : ["Minus", "-", "-", "-", 189, 189, false, true],
				"."   : ["Period", ".", ".", ".", 190, 190, false, true],
				"/"   : ["Slash", "/", "/", "/", 191, 191, false, true],
				"0"   : ["Digit0", "0", "0", "0", 48, 48, false, true],
				"1"   : ["Digit1", "1", "1", "1", 49, 49, false, true],
				"2"   : ["Digit2", "2", "2", "2", 50, 50, false, true],
				"3"   : ["Digit3", "3", "3", "3", 51, 51, false, true],
				"4"   : ["Digit4", "4", "4", "4", 52, 52, false, true],
				"5"   : ["Digit5", "5", "5", "5", 53, 53, false, true],
				"6"   : ["Digit6", "6", "6", "6", 54, 54, false, true],
				"7"   : ["Digit7", "7", "7", "7", 55, 55, false, true],
				"8"   : ["Digit8", "8", "8", "8", 56, 56, false, true],
				"9"   : ["Digit9", "9", "9", "9", 57, 57, false, true],
				":"   : ["Semicolon", ":", ":", ";", 186, 186, true, true],
				";"   : ["Semicolon", ";", ";", ";", 186, 186, false, true],
				"<"   : ["Comma", "<", "<", ",", 188, 188, true, true],
				"="   : ["Equal", "=", "=", "=", 187, 187, false, true],
				">"   : ["Period", ">", ">", ".", 190, 190, true, true],
				"?"   : ["Slash", "?", "?", "/", 191, 191, true, true],
				"@"   : ["Digit2", "@", "@", "2", 50, 50, true, true],
				"A"   : ["KeyA", "A", "A", "a", 65, 65, true, true],
				"B"   : ["KeyB", "B", "B", "b", 66, 66, true, true],
				"C"   : ["KeyC", "C", "C", "c", 67, 67, true, true],
				"D"   : ["KeyD", "D", "D", "d", 68, 68, true, true],
				"E"   : ["KeyE", "E", "E", "e", 69, 69, true, true],
				"F"   : ["KeyF", "F", "F", "f", 70, 70, true, true],
				"G"   : ["KeyG", "G", "G", "g", 71, 71, true, true],
				"H"   : ["KeyH", "H", "H", "h", 72, 72, true, true],
				"I"   : ["KeyI", "I", "I", "i", 73, 73, true, true],
				"J"   : ["KeyJ", "J", "J", "j", 74, 74, true, true],
				"K"   : ["KeyK", "K", "K", "k", 75, 75, true, true],
				"L"   : ["KeyL", "L", "L", "l", 76, 76, true, true],
				"M"   : ["KeyM", "M", "M", "m", 77, 77, true, true],
				"N"   : ["KeyN", "N", "N", "n", 78, 78, true, true],
				"O"   : ["KeyO", "O", "O", "o", 79, 79, true, true],
				"P"   : ["KeyP", "P", "P", "p", 80, 80, true, true],
				"Q"   : ["KeyQ", "Q", "Q", "q", 81, 81, true, true],
				"R"   : ["KeyR", "R", "R", "r", 82, 82, true, true],
				"S"   : ["KeyS", "S", "S", "s", 83, 83, true, true],
				"T"   : ["KeyT", "T", "T", "t", 84, 84, true, true],
				"U"   : ["KeyU", "U", "U", "u", 85, 85, true, true],
				"V"   : ["KeyV", "V", "V", "v", 86, 86, true, true],
				"W"   : ["KeyW", "W", "W", "w", 87, 87, true, true],
				"X"   : ["KeyX", "X", "X", "x", 88, 88, true, true],
				"Y"   : ["KeyY", "Y", "Y", "y", 89, 89, true, true],
				"Z"   : ["KeyZ", "Z", "Z", "z", 90, 90, true, true],
				"["   : ["BracketLeft", "[", "[", "[", 219, 219, false, true],
				"\\"  : ["Backslash", "\\", "\\", "\\", 220, 220, false, true],
				"]"   : ["BracketRight", "]", "]", "]", 221, 221, false, true],
				"^"   : ["Digit6", "^", "^", "6", 54, 54, true, true],
				"_"   : ["Minus", "_", "_", "-", 189, 189, true, true],
				"`"   : ["Backquote", "`", "`", "`", 192, 192, false, true],
				"a"   : ["KeyA", "a", "a", "a", 65, 65, false, true],
				"b"   : ["KeyB", "b", "b", "b", 66, 66, false, true],
				"c"   : ["KeyC", "c", "c", "c", 67, 67, false, true],
				"d"   : ["KeyD", "d", "d", "d", 68, 68, false, true],
				"e"   : ["KeyE", "e", "e", "e", 69, 69, false, true],
				"f"   : ["KeyF", "f", "f", "f", 70, 70, false, true],
				"g"   : ["KeyG", "g", "g", "g", 71, 71, false, true],
				"h"   : ["KeyH", "h", "h", "h", 72, 72, false, true],
				"i"   : ["KeyI", "i", "i", "i", 73, 73, false, true],
				"j"   : ["KeyJ", "j", "j", "j", 74, 74, false, true],
				"k"   : ["KeyK", "k", "k", "k", 75, 75, false, true],
				"l"   : ["KeyL", "l", "l", "l", 76, 76, false, true],
				"m"   : ["KeyM", "m", "m", "m", 77, 77, false, true],
				"n"   : ["KeyN", "n", "n", "n", 78, 78, false, true],
				"o"   : ["KeyO", "o", "o", "o", 79, 79, false, true],
				"p"   : ["KeyP", "p", "p", "p", 80, 80, false, true],
				"q"   : ["KeyQ", "q", "q", "q", 81, 81, false, true],
				"r"   : ["KeyR", "r", "r", "r", 82, 82, false, true],
				"s"   : ["KeyS", "s", "s", "s", 83, 83, false, true],
				"t"   : ["KeyT", "t", "t", "t", 84, 84, false, true],
				"u"   : ["KeyU", "u", "u", "u", 85, 85, false, true],
				"v"   : ["KeyV", "v", "v", "v", 86, 86, false, true],
				"w"   : ["KeyW", "w", "w", "w", 87, 87, false, true],
				"x"   : ["KeyX", "x", "x", "x", 88, 88, false, true],
				"y"   : ["KeyY", "y", "y", "y", 89, 89, false, true],
				"z"   : ["KeyZ", "z", "z", "z", 90, 90, false, true],
				"{"   : ["BracketLeft", "{", "{", "[", 219, 219, true, true],
				"|"   : ["Backslash", "|", "|", "\\", 220, 220, true, true],
				"}"   : ["BracketRight", "}", "}", "]", 221, 221, true, true],
				"~"   : ["Backquote", "~", "~", "`", 192, 192, true, true],
				"F1"  : ["F1", "F1", "", "", 112, 112, false, false],
				"F2"  : ["F2", "F2", "", "", 113, 113, false, false],
				"F3"  : ["F3", "F3", "", "", 114, 114, false, false],
				"F4"  : ["F4", "F4", "", "", 115, 115, false, false],
				"F5"  : ["F5", "F5", "", "", 116, 116, false, false],
				"F6"  : ["F6", "F6", "", "", 117, 117, false, false],
				"F7"  : ["F7", "F7", "", "", 118, 118, false, false],
				"F8"  : ["F8", "F8", "", "", 119, 119, false, false],
				"F9"  : ["F9", "F9", "", "", 120, 120, false, false],
				"F10" : ["F10", "F10", "", "", 121, 121, false, false],
				"F11" : ["F11", "F11", "", "", 122, 122, false, false],
				"F12" : ["F12", "F12", "", "", 123, 123, false, false],
				"ArrowDown"  : ["ArrowDown", "ArrowDown", "", "", 40, 40, false, false],
				"ArrowLeft"  : ["ArrowLeft", "ArrowLeft", "", "", 37, 37, false, false],
				"ArrowRight" : ["ArrowRight", "ArrowRight", "", "", 39, 39, false, false],
				"ArrowUp"    : ["ArrowUp", "ArrowUp", "", "", 38, 38, false, false],
				"End"      : ["End", "End", "", "", 35, 35, false, false],
				"Home"     : ["Home", "Home", "", "", 36, 36, false, false],
				"PageDown" : ["PageDown", "PageDown", "", "", 34, 34, false, false],
				"PageUp"   : ["PageUp", "PageUp", "", "", 33, 33, false, false]
			};

			const eventOptions =
			{
				key                   : KEYMAP[c][1],
				code                  : KEYMAP[c][0],
				nativeVirtualKeyCode  : KEYMAP[c][4],
				windowsVirtualKeyCode : KEYMAP[c][5]
			};

			if(options.alt)
				eventOptions.modifiers = 1;
			else if(options.ctrl)
				eventOptions.modifiers = 2;
			else if(options.meta)
				eventOptions.modifiers = 4;
			else if(options.shift)
				eventOptions.modifiers = 8;

			if(["alt", "ctrl", "meta", "shift"].filter(v => options.hasOwnProperty(v)).length>1)
				return cb(new Error("CDPW.sendChar does not currently support more than 1 modifier at a time. Was lazy."));

			tiptoe(
				function sendKeyDown()	{ cdpw.client.Input.dispatchKeyEvent({...eventOptions, type : "keyDown" }, this); },
				function sendChar()
				{
					if(KEYMAP[c][2] && KEYMAP[c][2]!=="\r")
						cdpw.client.Input.dispatchKeyEvent({...eventOptions, type : "char", text : KEYMAP[c][2], unmodifiedText : KEYMAP[c][3]}, this);
					else
						this();
				},
				function sendKeyUp()	{ cdpw.client.Input.dispatchKeyEvent({...eventOptions, type : "keyUp" }, this); },
				cb
			);
		}

		// Press several keys
		pressKeys(keys, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb, {interval : 10});

			const cdpw=this;

			(Array.isArray(keys) ? keys : keys.split("")).serialForEach((key, subcb) => cdpw.pressKey(key, options, err => (err ? subcb(err) : setTimeout(subcb, options.interval))), cb);
		}

		// Clicks the given target
		click(target, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb);

			const cdpw=this;

			tiptoe(
				function getXY()
				{
					if(Array.isArray(target))
						this(undefined, target);
					else
						cdpw.getXY(target, options, this);
				},
				function performClick(xy)
				{
					tiptoe(
						function move()		{ cdpw.mouseMove(xy, options, this); },
						function press() 	{ cdpw.mouseDown(xy, options, this); },
						function wait() 	{ setTimeout(this, 50); },
						function release() 	{ cdpw.mouseUp(xy, options, this); },
						this
					);
				},
				cb
			);
		}

		// Right clicks on the target
		rightClick(target, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb);

			this.click(target, {...options, button : "right"}, cb);
		}

		// Double clicks the given target
		doubleClick(target, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb);

			const cdpw=this;

			tiptoe(
				function getXY()
				{
					if(Array.isArray(target))
						this(undefined, target);
					else
						cdpw.getXY(target, options, this);
				},
				function performDoubleClick(xy)
				{
					tiptoe(
						function clickOne() 	{ cdpw.click(xy, options, this); },
						function wait() 		{ setTimeout(this, 150); },
						function clickTwo() 	{ cdpw.click(xy, options, this); },
						this
					);
				},
				cb
			);
		}

		// Will listen for the given chrome devtools protocol event
		listen(eventName, handler)
		{
			if(!this.eventListeners.hasOwnProperty(eventName))
				this.eventListeners[eventName] = [];
			
			this.eventListeners[eventName].pushUnique(handler);
		}

		// Will remove the listener handler for the given chrome devtools protocol event
		unlisten(eventName, handler)
		{
			this.eventListeners[eventName].removeOnce(handler);
		}

		// Called when an event happens
		eventHandler(msg)
		{
			if(this.eventListeners.hasOwnProperty(msg.method))
				this.eventListeners[msg.method].forEach(handler => handler(msg));
		}

		// Closes the cdp client first, then kills the chromium child process
		destroy(cb)
		{
			const cdpw=this;

			tiptoe(
				function closeClient()
				{
					if(!cdpw.client)
						return this();

					this.capture();
					cdpw.client.close(this);
				},
				function closeChromeProcess()
				{
					if(!cdpw.cp)
						return this();

					this.capture();
					if(cdpw.cp.exitCode!==null)
						return this();
						
					cdpw.cp.on("exit", this);
					cdpw.cp.kill();
				},
				function cleanupUserDir()
				{
					fileUtil.unlink(cdpw.userDataDir, this);
				},
				cb
			);
		}

		// Will save any stream of network responses to disk. Useful for saving streaming video to disk
		// options.match.mimeType = "video/mp2t"	By default it matches any responses with this mimeType
		// options.finishAfter = XU.MINUTE			How long to wait for more data before finishing the file and calling the cb
		saveResponsesToDisk(filePath, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb, { match : { mimeType : "video/mp2t" }, finishAfter : XU.MINUTE });

			const requestIds = [];
			const dataContent = {};
			const SAVE_TO_DISK_INTERVAL = 200;

			const cdpw=this;
			cdpw.listen("Network.responseReceived", saveEventHandler);
			cdpw.listen("Network.loadingFinished", saveEventHandler);

			function saveEventHandler(msg)
			{
				if(msg.method==="Network.responseReceived")
				{
					if(options.match.mimeType && msg.params.response.mimeType!==options.match.mimeType)
						return;

					// Add future match types here, such as filenames, urls, etc
					
					requestIds.push(msg.params.requestId);
					dataContent[msg.params.requestId] = null;
				}

				if(msg.method==="Network.loadingFinished")
				{
					const requestId = msg.params.requestId;

					cdpw.client.Network.getResponseBody({requestId}, (err, result) =>
					{
						if(err)
						{
							console.error("saveEventHandler.getResponseData");
							console.trace();
							console.error(requestId, err, result);
							//return finish(err);
						}
						
						if(result?.body)
							dataContent[requestId] = Buffer.from(result.body, (result.base64Encoded ? "base64" : "utf8"));
					});
				}
			}

			let saveToDiskTimeoutid = null;

			let fd = null;
			tiptoe(
				function openTargetFile() { fs.open(filePath, "w", this); },
				function startSaving(err, _fd)
				{
					fd = _fd;

					if(err)
					{
						console.error("startSaving");
						console.trace();
						console.error(filePath, err, _fd);
						return finish(err);
					}
	
					saveToDiskTimeoutid = setTimeout(saveToDiskIfNeeded, SAVE_TO_DISK_INTERVAL);
				}
			);

			let finishTimeoutid = null;

			function saveToDiskIfNeeded()
			{
				saveToDiskTimeoutid = null;

				if(requestIds.length===0 || !dataContent[requestIds[0]])
				{
					saveToDiskTimeoutid = setTimeout(saveToDiskIfNeeded, SAVE_TO_DISK_INTERVAL);
					return;
				}

				const requestId = requestIds.shift();

				tiptoe(
					function writeData() { fs.write(fd, dataContent[requestId], this); },
					function reschedule(err)
					{
						//console.log("[%s] [%s] Saved %s bytes to disk", moment().format("ddd MMM Do, YYYY - H:mm:ss"), requestId, dataContent[requestId].length.toLocaleString(), err);

						if(err)
							return finish(err);
						
						delete dataContent[requestId];

						saveToDiskTimeoutid = setTimeout(saveToDiskIfNeeded, SAVE_TO_DISK_INTERVAL);

						if(finishTimeoutid!==null)
							clearTimeout(finishTimeoutid);
						
						finishTimeoutid = setTimeout(finishSaving, options.finishAfter);
					}
				);
			}

			function finishSaving()
			{
				finishTimeoutid = null;

				if(saveToDiskTimeoutid!==null)
				{
					clearTimeout(saveToDiskTimeoutid);
					saveToDiskTimeoutid = null;
				}

				fs.close(fd, finish);
			}

			function finish(err)
			{
				if(err)
				{
					console.trace();
					console.error(arguments);		// eslint-disable-line prefer-rest-params

					cdpw.client.Page.captureScreenshot({format : "png"}, (sserr, ss) =>
					{
						if(sserr)
						{
							console.trace();
							console.error(sserr);
							console.error("Failed to capture screenshot of page in failure.");
							return cb(err);
						}

						fs.writeFileSync("/tmp/saveResponseToDisk_failed_ss.png", Buffer.from(ss.data, "base64"));

						return cb(err);
					});

					return;
				}

				cdpw.unlisten("Network.responseReceived", saveEventHandler);
				cdpw.unlisten("Network.loadingFinished", saveEventHandler);

				cb();
			}
		}

		// Capture a screenshot
		static captureScreenshot(url, _options, _cb)
		{
			const {options, cb} = XU.optionscb(_options, _cb, {width : 1280, height : 1024, delay : XU.SECOND});

			const cdpw = new CDPW(true, (cdpwErr, client) =>
			{
				if(cdpwErr)
					return cb(cdpwErr);
				
				tiptoe(
					function init()
					{
						cdpw.open({width : options.width, height : options.height}, this);
					},
					function openSite()
					{
						cdpw.navigate(url, {delay : options.delay}, this);
					},
					function capture()
					{
						client.Page.captureScreenshot({format : "png"}, this);
					},
					function cleanup(ss)
					{
						this.data.ssData = Buffer.from(ss.data, "base64");
						cdpw.destroy(this);
					},
					function resturnResult(err)
					{
						if(err)
							return cb(err);

						cb(undefined, this.data.ssData);
					}
				);
			});
		}
	}

	module.exports = CDPW;
})();

