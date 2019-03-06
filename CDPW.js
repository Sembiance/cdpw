"use strict";

/* eslint-disable consistent-this */

const base = require("@sembiance/xbase"),
	runUtil = require("@sembiance/xutil").run,
	netUtil = require("@sembiance/xutil").net,
	tiptoe = require("tiptoe"),
	fs = require("fs"),
	rimraf = require("rimraf"),
	fileUtil = require("@sembiance/xutil").file,
	util = require("util"),		// eslint-disable-line no-unused-vars
	cdp = require("chrome-remote-interface");

(function _CDPW()
{
	class CDPW
	{
		constructor(_headless, cb)
		{
			const cdpw=this;
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
					const chromeLaunchArgs = ["--user-data-dir=" + cdpw.userDataDir];
					if(cdpw.headless)
						chromeLaunchArgs.push("--headless", "--hide-scrollbars", "--disable-gpu", "--window-size=1200,960");
					chromeLaunchArgs.push("--disable-infobars", "--disable-default-apps", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpw.debugPort);
				
					runUtil.run("chromium", chromeLaunchArgs, {silent : true, detached : true, env : { DISPLAY : ":0" }}, this);
				},
				function waitForConnection(cp)
				{
					cdpw.cp = cp;

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
					cb(undefined, client);
				}
			);
		}

		// Opens the given url with the given options
		openURL(url, cb, options={})
		{
			const deviceMetrics = {
				deviceScaleFactor : 0,
				mobile            : false,
				fitWindow         : false
			};

			deviceMetrics.width = options.width || (this.headless ? 1200 : 0);
			deviceMetrics.height = options.height || (this.headless ? 960 : 0);

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
				function navigate()
				{
					cdpw.client.Page.navigate({url}, this);
				},
				function waitForPageToLoad()
				{
					const self=this;
					cdpw.client.Page.loadEventFired(() => setTimeout(self, (options.delay || 0)));
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

				if(!["number", "string", "boolean"].includes(result.result.type))
				{
					console.log(result);
					return cb(new Error("CDPW.evaluate: Unsupported result type [" + result.result.type + "] for expression: ", expression));
				}

				cb(undefined, result.result.value);
			});
		}

		// Runs the passed in function fun continually until it calls it's subcb with a truthy second value or until timeout has passed
		wait(fun, timeout, cb)
		{
			const timeoutid = setTimeout(() => cb(new Error("CDPW.wait timed out")), timeout);

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
			this.evaluate(`window.getComputedStyle(document.querySelector("${selector.replaceAll('"', '\\"')}")).display!=="none"`, (suberr, r) => (suberr ? cb(suberr) : cb(undefined, r)));
		}

		// Runs the given selector on the document
		querySelector(selector, cb)
		{
			this.client.DOM.querySelector({nodeId : this.document.root.nodeId, selector}, (err, result) =>
			{
				if(err || !result || !result.nodeId)
					return cb([new Error("Invalid selector: " + selector), result, err]);
					
				cb(undefined, result.nodeId);
			});
		}

		// Returns the innerText of the given target
		getText(selector, cb)
		{
			this.evaluate(`document.querySelector("${selector.replaceAll('"', '\\"')}").innerText`, (suberr, r) => (suberr ? cb(suberr) : cb(undefined, r)));
		}

		// Returns the XY coordinate of the given target using client side getBoundingClientRect() which may be more accurate or different than the getBoxModel
		/*getXY(selector, cb, options={})
		{
			// XY offset from top left for where to click. Integer values are absolute pixels, strings percentages are a percentage of the target's width and height
			if(!options.hasOwnProperty("offset"))
				options.offset = ["50%", "50%"];

			this.evaluate(`JSON.stringify(document.querySelector("${selector.replaceAll('"', '\\"')}").getBoundingClientRect())`, (err, rs) =>
			{
				if(err)
					return cb(err);

				const r = JSON.parse(rs);

				//console.log(util.inspect(r, {depth : 9, colors : true}));
				const xy = [r.x, r.y];
				if(options.offset)
				{
					const offsets = options.offset.map((v, i) => ((typeof v==="string" && v.endsWith("%")) ? (((+v.substring(v, v.length-1))/100)*r[(["width", "height"][i])]) : v));
					xy.mapInPlace((xory, i) => xory+offsets[i]);
				}
				//console.log(selector, r, xy);
				cb(undefined, xy);
			});
		}*/

		// Returns the XY coordinate of the given selector
		getXY(selector, cb, options={})
		{
			const cdpw=this;

			// XY offset from top left for where to click. Integer values are absolute pixels, strings percentages are a percentage of the target's width and height
			if(!options.hasOwnProperty("offset"))
				options.offset = ["50%", "50%"];

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
						return cb(err);

					const xy = r.model.content.slice(0, 2);
					if(options.offset)
					{
						const offsets = options.offset.map((v, i) => ((typeof v==="string" && v.endsWith("%")) ? (((+v.substring(v, v.length-1))/100)*r.model[(["width", "height"][i])]) : v));
						xy.mapInPlace((xory, i) => xory+offsets[i]);
					}
					
					cb(undefined, xy);
				}
			);
		}

		// Perform a mouse event on the given target (string selector, array of x/y coords or an integer nodeId)
		mouseEvent(target, type, cb, options={})
		{
			const cdpw = this;

			tiptoe(
				function getXY()
				{
					if(Array.isArray(target))
						this(undefined, target);
					else
						cdpw.getXY(target, this, options);
				},
				function dispatchMouseEvent(xy)
				{
					const mouseEventOptions = {
						type,
						x          : xy[0],
						y          : xy[1],
						button     : (options.button || "left"),
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

		// Clicks the given target
		click(target, cb, options)
		{
			const cdpw=this;

			tiptoe(
				function getXY()
				{
					if(Array.isArray(target))
						this(undefined, target);
					else
						cdpw.getXY(target, this, options);
				},
				function performClick(xy)
				{
					tiptoe(
						function move()		{ cdpw.mouseMove(xy, this, options); },
						function press() 	{ cdpw.mouseDown(xy, this, options); },
						function wait() 	{ setTimeout(this, 50); },
						function release() 	{ cdpw.mouseUp(xy, this, options); },
						this
					);
				},
				cb
			);
		}

		// Double clicks the given target
		doubleClick(target, cb, options)
		{
			const cdpw=this;

			tiptoe(
				function getXY()
				{
					if(Array.isArray(target))
						this(undefined, target);
					else
						cdpw.getXY(target, this, options);
				},
				function performDoubleClick(xy)
				{
					tiptoe(
						function clickOne() 	{ cdpw.click(xy, this, options); },
						function wait() 		{ setTimeout(this, 150); },
						function clickTwo() 	{ cdpw.click(xy, this, options); },
						this
					);
				},
				cb
			);
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
					cdpw.cp.on("exit", this);
					cdpw.cp.kill();
				},
				function cleanupUserDir()
				{
					rimraf(cdpw.userDataDir, this);
				},
				cb
			);
		}
	}

	module.exports = CDPW;
})();

