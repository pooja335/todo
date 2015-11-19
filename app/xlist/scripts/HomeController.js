angular
  .module('xlist')
  .controller('HomeController',
      ['$scope', '$q', 'supersonic', 'GeoList', 'Task', 'deviceReady',
       'slackbot', 'push', 'ParseObject',
  function($scope, $q, supersonic, GeoList, Task, deviceReady, slackbot, push,
           ParseObject) {
    $scope.pairs = [];
    $scope.disableAdd = false;
    var fields = ['name', 'done', 'category', 'deadline'];
    var overrideLocation = null;

    // Haversine formula for getting distance in miles.
    var getDistance = function(p1, p2) {
      var R = 6378137; // Earth’s mean radius in meter
      var degToRad = Math.PI / 180; // Degree to radian conversion.
      var dLat = (p2.latitude - p1.latitude) * degToRad;
      var dLong = (p2.longitude - p1.longitude) * degToRad;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(p1.latitude * degToRad) * Math.cos(p2.latitude * degToRad) *
          Math.sin(dLong / 2) * Math.sin(dLong / 2);
      var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      var d = R * c; // d = distance in meters
      return d / 1609; // Returns the distance in miles.
    };

    $scope.setLocation = function() {
      supersonic.ui.dialog.prompt('Set Location', {
        message: 'Enter the name of list whose location you want to simulate'
      }).then(function(result) {
        if (result.buttonIndex === 0) {
          var pair = _.find($scope.pairs, function(pair) {
            return pair.geoList.name.toLowerCase() ===
                result.input.toLowerCase();
          });
          if (pair) {
            overrideLocation = pair.geoList.location;
            supersonic.ui.dialog.alert('Set Location', {
              message: 'Location set to location of ' + pair.geoList.name + '.'
            });
          } else {
            supersonic.ui.dialog.alert('Set Location', {
              message: 'No such list found.'
            });
          }
        }
      });
    };

    var getLocation = function() {
      var deferred = $q.defer();
      if (overrideLocation) {
        deferred.resolve(overrideLocation);
      }
      supersonic.device.geolocation.getPosition().then(function(position) {
        var hardwareLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timestamp: position.timestamp
        };
        deferred.resolve(hardwareLocation);
      }, deferred.reject);
      return deferred.promise;
    };

    var pushNear = function(pair) {
      var now = new Date().getTime();
      var nextNotification = pair.geoList.nextNotification;
      if (!nextNotification || now > nextNotification) {
        pair.geoList.nextNotification = now + 1000 * 90;
        pair.geoList.save();
        var incomplete = _.filter(pair.tasks, function(task) {
          return !task.done;
        }).length;
        if (incomplete) {
          var message = 'Pick up ' + incomplete + ' item' +
              (incomplete > 1 ? 's' : '') + ' at ' + pair.geoList.name + '.';
          push.send({
            title: 'ToDo',
            message: message
          });
          slackbot('ToDo: ' + message);
        }
      }
    };

    var THRESHOLD = 0.25;

    var findNearAndPassLocation = function(location) {
      _.each($scope.pairs, function(pair) {
        var distance = getDistance(location, pair.geoList.location);
        if (distance < THRESHOLD) {
          pushNear(pair);
        }
      });
      // used to pass location to location controller
      supersonic.data.channel('location').publish(location);
    };

    deviceReady().then(function() {
      cordova.plugins.backgroundMode.configure({
        silent: true
      });
      cordova.plugins.backgroundMode.enable();
      if (!cordova.plugins.backgroundMode.isEnabled()) {
        supersonic.ui.dialog.alert('Failed to enable background mode.');
      }
      window.setInterval(function() {
        getLocation().then(findNearAndPassLocation);
      }, 10 * 1000);
    });

    var alertParseError = function(error) {
      supersonic.ui.dialog.alert('Error: ' + error.code + ' ' + error.message);
    };

    var getTasks = function(geoList) {
      var deferred = $q.defer();
      var queryTasks = new Parse.Query(Task);
      queryTasks.equalTo('geoList', geoList.toPointer()).find()
          .then(function(results) {
            var tasks = [];
            for (var i = 0; i < results.length; i++) {
              tasks.push(new ParseObject(results[i], Task.fields));
              tasks[i].editing = false;
            }
            deferred.resolve(tasks);
          }, alertParseError);
      return deferred.promise;
    };

    var initialize = function() {
      var newPairs = [];
      var queryGeoLists = new Parse.Query(GeoList);
      queryGeoLists.each(function(geoList) {
        return getTasks(geoList).then(function(tasks) {
          newPairs.push({
            geoList: new ParseObject(geoList, GeoList.fields),
            tasks: tasks
          });
        });
      }).then(function() {
        $scope.pairs = _.sortBy(newPairs, function(pair) {
          return pair.geoList.name;
        });
      });
    };

    $scope.addTask = function(pair) {
      var newTask = new ParseObject(new Task(), Task.fields);
      newTask.name = '';
      newTask.category = '';
      newTask.done = false;
      newTask.geoList = pair.geoList.data.toPointer();
      pair.tasks.push(newTask);
      $scope.disableAdd = true;
    };

    var saveTask = function(pair, index, taskContent) {
      var task = pair.tasks[index];
      task.name = (taskContent || task.name).trim();
      if (task.name.length) {
        task.done = false;
        task.save().catch(alertParseError);
      } else {
        $scope.deleteTask(pair, index);
      }
      $scope.disableAdd = false;
    };

    $scope.taskEnter = function(event, pair, index) {
      if (event.which === 13) {
        event.preventDefault();
        var taskElement = document.getElementById(
            'task-' + pair.geoList.data.id + '-' + index.toString());
        var taskContent = taskElement.innerText;
        saveTask(pair, index, taskContent);
        taskElement.innerText = taskContent;
        taskElement.blur();
      }
    };

    $scope.deleteTask = function(pair, index) {
      if (index == pair.tasks.length - 1 && $scope.disableAdd) {
        pair.tasks.splice(index, 1);
        $scope.disableAdd = false;
      } else {
        pair.tasks[index].delete().then(function(result) {
          pair.tasks.splice(index, 1);
          if (pair.tasks.length === 0) {
            congratsAlert();
          }
        }, alertParseError);
      }
    };

    $scope.toggleTask = function(pair, task) {
      task.done = !task.done;
      task.save()
        .then(function(results) {
          if (allTasksDone(pair)) {
            congratsAlert();
          }
        }, alertParseError);
    };

    var congratsAlert = function() {
      var options = {
        message: 'You\'ve finished all your tasks!',
        buttonLabel: 'Hooray!'
      };
      supersonic.ui.dialog.alert('Congratulations!', options);
    };

    var allTasksDone = function(pair) {
      return _.every(pair.tasks, function(task) {
        return task.done;
      });
    };

    supersonic.ui.views.current.whenVisible(initialize);
  }]);
