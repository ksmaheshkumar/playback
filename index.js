var request = require('request')
var drop = require('drag-and-drop-files')
var mdns = require('multicast-dns')()
var concat = require('concat-stream')
var vtt = require('srt-to-vtt')
var ipc = require('ipc')
var remote = require('remote')
var Menu = remote.require('menu')
var MenuItem = remote.require('menu-item')
var http = require('http')
var rangeParser = require('range-parser')
var pump = require('pump')
var fs = require('fs')
var eos = require('end-of-stream')
var minimist = require('minimist')
var JSONStream = require('JSONStream')
var network = require('network-address')
var chromecasts = require('chromecasts')()
var $ = require('dombo')
var player = require('./player')
var playlist = require('./playlist')
var mouseidle = require('./mouseidle')

var argv = minimist(JSON.parse(window.location.toString().split('#')[1]), {
  alias: {follow: 'f'},
  boolean: ['follow']
})

var printError = function (err) {
  if (err) console.log(err)
}

var onsubs = function (data) {
  media.subtitles(data)
}

ipc.on('add-to-playlist', function (links) {
  links.forEach(function (link) {
    if (/\.(vtt|srt)$/i.test(link)) {
      fs.createReadStream(link).pipe(vtt()).pipe(concat(onsubs))
      return
    }

    list.add(link, printError)
  })
})

var media = player($('#player')[0])
var list = playlist()

drop($('body')[0], function (files) {
  for (var i = 0; i < files.length; i++) {
    if (/\.(vtt|srt)$/i.test(files[i].path)) {
      fs.createReadStream(files[i].path).pipe(vtt()).pipe(concat(onsubs))
      return
    }

    list.add(files[i].path, printError)
  }
})

var videoDown = false
var videoOffsets = [0, 0]

$('#idle').on('mousedown', function (e) {
  videoDown = true
  videoOffsets = [e.clientX, e.clientY]
})

$('#idle').on('mouseup', function () {
  videoDown = false
})

$('#idle').on('mousemove', function (e) {
  if (videoDown) remote.getCurrentWindow().setPosition(e.screenX - videoOffsets[0], e.screenY - videoOffsets[1])
})

var onTop = false

$(window).on('contextmenu', function (e) {
  e.preventDefault()

  var menu = new Menu()

  menu.append(new MenuItem({
    label: 'Always on top',
    type: 'checkbox',
    checked: onTop,
    click: function () {
      onTop = !onTop
      remote.getCurrentWindow().setAlwaysOnTop(onTop)
    }
  }))

  if (media.subtitles()) {
    menu.append(new MenuItem({
      label: 'Remove subtitles',
      click: function () {
        media.subtitles(null)
      }
    }))
  }

  menu.popup(remote.getCurrentWindow())
})

$('body').on('mouseover', function () {
  if (onTop) ipc.send('focus')
})

var isFullscreen = false

var onfullscreentoggle = function (e) {
  if (!isFullscreen && e.shiftKey) {
    ipc.send('resize', {
      width: media.width,
      height: media.height,
      ratio: media.ratio
    })
    return
  }

  var $icon = $('#controls-fullscreen .mega-octicon')
  if (isFullscreen) {
    isFullscreen = false
    $('#menubar')[0].style.display = 'block'
    $icon.removeClass('octicon-screen-normal')
    $icon.addClass('octicon-screen-full')
    ipc.send('exit-full-screen')
  } else {
    isFullscreen = true
    $('#menubar')[0].style.display = 'none'
    $icon.removeClass('octicon-screen-full')
    $icon.addClass('octicon-screen-normal')
    ipc.send('enter-full-screen')
  }
}

var onplaytoggle = function () {
  if (media.playing) media.pause()
  else media.play()
}

$('#idle').on('dblclick', onfullscreentoggle)
$('#controls-fullscreen').on('click', onfullscreentoggle)

$('#controls-timeline').on('click', function (e) {
  var time = e.pageX / $('#controls-timeline')[0].offsetWidth * media.duration
  media.time(time)
})

$(document).on('keydown', function (e) {
  if (e.keyCode === 27 && isFullscreen) return onfullscreentoggle(e)
  if (e.keyCode === 13 && e.metaKey) return onfullscreentoggle(e)
  if (e.keyCode === 13 && e.shiftKey) return onfullscreentoggle(e)
  if (e.keyCode === 32) return onplaytoggle(e)

  if ($('#controls-playlist').hasClass('selected')) $('#controls-playlist').trigger('click')
  if ($('#controls-broadcast').hasClass('selected')) $('#controls-broadcast').trigger('click')
})

mouseidle($('#idle')[0], 3000, 'hide-cursor')

list.on('select', function () {
  $('#controls-name')[0].innerText = list.selected.name
  media.play('http://127.0.0.1:' + server.address().port + '/' + list.selected.id)
  if (list.selected.subtitles) onsubs(list.selected.subtitles)
  updatePlaylist()
})

var updatePlaylist = function () {
  var html = ''

  list.entries.forEach(function (entry, i) {
    html += '<div class="playlist-entry ' + (i % 2 ? 'odd ' : '') + (list.selected === entry ? 'selected ' : '') + '" data-index="' + i + '" data-id="' + entry.id + '">' +
      '<span>' + entry.name + '</span><span class="status octicon"></span></div>'
  })

  $('#playlist-entries')[0].innerHTML = html
}

var updateBroadcast = function () {
  var html = ''

  chromecasts.players.forEach(function (player, i) {
    html += '<div class="broadcast-entry ' + (i % 2 ? 'odd ' : '') + (media.casting === player ? 'selected ' : '') + '" data-index="' + i + '" data-id="' + i + '">' +
      '<span>' + player.name + '</span>'
  })

  $('#broadcast-entries')[0].innerHTML = html
}

chromecasts.on('update', updateBroadcast)

var updateSpeeds = function () {
  $('#player-downloadspeed')[0].innerText = ''
  list.entries.forEach(function (entry, i) {
    if (!entry.downloadSpeed) return

    $('.playlist-entry[data-index="' + i + '"] .status').addClass('octicon-sync')

    var kilobytes = entry.downloadSpeed() / 1024
    var megabytes = kilobytes / 1024
    var text = megabytes > 1 ? megabytes.toFixed(1) + ' mb/s' : Math.floor(kilobytes) + ' kb/s'

    if (list.selected === entry) $('#player-downloadspeed')[0].innerText = text
  })
}
setInterval(updateSpeeds, 750)

list.on('update', updatePlaylist)

list.once('update', function () {
  list.select(0)
})

var popupSelected = function () {
  return $('#controls-playlist').hasClass('selected') || $('#controls-broadcast').hasClass('selected')
}

var closePopup = function (e) {
  if (e && (e.target === $('#controls-playlist .mega-octicon')[0] || e.target === $('#controls-broadcast .mega-octicon')[0])) return
  $('#popup')[0].style.opacity = 0
  $('#controls-playlist')[0].className = ''
  $('#controls-broadcast')[0].className = ''
}

$('#controls').on('click', closePopup)
$('#drag').on('click', closePopup)
$('#idle').on('click', closePopup)

$('#playlist-entries').on('click', '.playlist-entry', function (e) {
  var id = Number(this.getAttribute('data-id'))
  list.select(id)
})

$('#broadcast-entries').on('click', '.broadcast-entry', function (e) {
  var id = Number(this.getAttribute('data-id'))
  var player = chromecasts.players[id]

  if (media.casting === player) {
    $('body').removeClass('broadcasting')
    media.chromecast(null)
    return updateBroadcast()
  }

  $('body').addClass('broadcasting')
  media.chromecast(player)
  updateBroadcast()
})

var updatePopup = function () {
  if (popupSelected()) {
    $('#popup')[0].style.display = 'block'
    $('#popup')[0].style.opacity = 1
  } else {
    $('#popup')[0].style.opacity = 0
  }
}

$('#controls-broadcast').on('click', function () {
  $('#popup')[0].className = 'broadcast'
  $('#controls-playlist')[0].className = ''
  $('#controls-broadcast').toggleClass('selected')
  chromecasts.update()
  updatePopup()
})

$('#controls-playlist').on('click', function (e) {
  $('#popup')[0].className = 'playlist'
  $('#controls-playlist').toggleClass('selected')
  $('#controls-broadcast')[0].className = ''
  updatePopup()
})

$('#playlist-add-media').on('click', function () {
  ipc.send('open-file-dialog')
})

$('#popup').on('transitionend', function () {
  if (!popupSelected()) $('#popup')[0].style.display = 'none'
})

$('#menubar-close').on('click', function () {
  ipc.send('close')
})

$('#menubar-minimize').on('click', function () {
  ipc.send('minimize')
})

$('#menubar-maximize').on('click', function () {
  ipc.send('maximize')
})

var formatTime = function (secs) {
  var hours = (secs / 3600) | 0
  var mins = ((secs - hours * 3600) / 60) | 0
  secs = (secs - (3600 * hours + 60 * mins)) | 0
  if (mins < 10) mins = '0' + mins
  if (secs < 10) secs = '0' + secs
  return (hours ? hours + ':' : '') + mins + ':' + secs
}

var updateInterval
media.on('metadata', function () {
  // TODO: comment in again when not quirky
  // if (!isFullscreen) {
  //   ipc.send('resize', {
  //     width: media.width,
  //     height: media.height,
  //     ratio: media.ratio
  //   })
  // }

  $('#controls-main')[0].style.display = 'block'
  $('#controls-time-total')[0].innerText = formatTime(media.duration)
  $('#controls-time-current')[0].innerText = formatTime(media.time())

  clearInterval(updateInterval)
  updateInterval = setInterval(function () {
    $('#controls-timeline-position')[0].style.width = (100 * (media.time() / media.duration)) + '%'
    $('#controls-time-current')[0].innerText = formatTime(media.time())
  }, 250)
})

$('#controls-play').on('click', onplaytoggle)

media.on('end', function () {
  list.selectNext()
})

media.on('play', function () {
  if (media.casting) {
    $('#splash')[0].className = ''
    $('#player')[0].className = 'hidden'
  } else {
    $('#splash')[0].className = 'hidden'
    $('#player')[0].className = ''
  }
  $('#controls-play .mega-octicon')[0].className = 'mega-octicon octicon-playback-pause'
})

media.on('pause', function () {
  $('#controls-play .mega-octicon')[0].className = 'mega-octicon octicon-playback-play'
})

var server = http.createServer(function (req, res) {
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin)

  if (req.url === '/subtitles') {
    var buf = media.subtitles()

    if (buf) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    } else {
      res.statusCode = 404
      res.end()
    }
  }

  if (req.url === '/follow') { // TODO: do not hardcode /0
    if (!list.selected) return res.end()
    var stringify = JSONStream.stringify()

    var onseek = function () {
      stringify.write({type: 'seek', time: media.time() })
    }

    var onsubs = function (data) {
      stringify.write({type: 'subtitles', data: data.toString('base64')})
    }

    stringify.pipe(res)
    stringify.write({type: 'open', url: 'http://' + network() + ':' + server.address().port + '/' + list.selected.id, time: media.time() })

    media.on('subtitles', onsubs)
    media.on('seek', onseek)
    eos(res, function () {
      media.removeListener('subtitles', onsubs)
      media.removeListener('seek', onseek)
    })
    return
  }

  var id = Number(req.url.slice(1))
  var file = list.get(id)

  if (!file) {
    res.statusCode = 404
    res.end()
    return
  }

  var range = req.headers.range && rangeParser(file.length, req.headers.range)[0]

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', 'video/mp4')

  if (!range) {
    res.setHeader('Content-Length', file.length)
    if (req.method === 'HEAD') return res.end()
    pump(file.createReadStream(), res)
    return
  }

  res.statusCode = 206
  res.setHeader('Content-Length', range.end - range.start + 1)
  res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.length)
  if (req.method === 'HEAD') return res.end()
  pump(file.createReadStream(range), res)
})

server.listen(0, function () {
  console.log('Playback server running on port ' + server.address().port)

  argv._.forEach(function (file) {
    if (file) list.add(file, printError)
  })

  if (argv.follow) {
    mdns.on('response', function onresponse(response) {
      response.answers.forEach(function (a) {
        if (a.name !== 'playback') return
        clearInterval(interval)
        mdns.removeListener('response', onresponse)

        var host = a.data.target + ':' + a.data.port

        request('http://' + host + '/follow').pipe(JSONStream.parse('*')).on('data', function (data) {
          if (data.type === 'open') {
            media.play(data.url)
            media.time(data.time)
          }

          if (data.type === 'seek') {
            media.time(data.time)
          }

          if (data.type === 'subtitles') {
            media.subtitles(data.data)
          }
        })
      })
    })

    var query = function () {
      mdns.query({
        questions: [{
          name: 'playback',
          type: 'SRV'
        }]
      })
    }

    var interval = setInterval(query, 5000)
    query()
  } else {
    mdns.on('query', function (query) {
      var valid = query.questions.some(function (q) {
        return q.name === 'playback'
      })

      if (!valid) return

      mdns.respond({
        answers: [{
          type: 'SRV',
          ttl: 5,
          name: 'playback',
          data: {port: server.address().port, target: network()}
        }]
      })
    })
  }

  setTimeout(function () {
    ipc.send('ready')
  }, 10)
})
