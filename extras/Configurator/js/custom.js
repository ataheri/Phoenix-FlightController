var connectionId = -1;
var port_list;
var serial_poll;

var eepromConfig;

var testing = 0;

$(document).ready(function() { 
    var port_picker = $('div#port-picker .port');
    var baud_picker = $('div#port-picker #baud');
    var delay_picker = $('div#port-picker #delay');
    
    $('div#port-picker a.refresh').click(function() {
        console.log("Available port list requested.");
        port_picker.html('');

        chrome.serial.getPorts(function(ports) {
            if (ports.length > 0) {
                // Port list received
                port_picker.html('<select id="port"></select>');
                
                ports.forEach(function(port) {
                    $('select', port_picker).append($("<option/>", {
                        value: port,
                        text: port
                    }));        
                });
            } else {
                // Looks like this check is kinda useless as the serial API doesn't seem to work in windows
                // at all, requires v25>
                // No serial ports found (do something/offer solution)
                console.log("No serial ports detected");
            }
        });
    });
    
    // software click to refresh port picker select during first load
    $('div#port-picker a.refresh').click();
    
    $('div#port-picker a.connect').click(function() {
        var clicks = $(this).data('clicks');
        
        if (clicks) { // odd number of clicks
            chrome.serial.close(connectionId, onClosed);
            
            clearInterval(serial_poll);
            
            $(this).text('Connect');        
        } else { // even number of clicks         
            var selected_port = $('select#port', port_picker).val();
            var selected_baud = parseInt(baud_picker.val());
            var selected_delay = parseInt(delay_picker);
            
            chrome.serial.open(selected_port, {
                bitrate: selected_baud
            }, onOpen);
            
            setTimeout(function() {
                // start polling
                serial_poll = setInterval(readPoll, 10);
            }, selected_delay * 1000);    
            
            $(this).text('Disconnect');            
        }
        
        $(this).data("clicks", !clicks);
    }); 

    // Tabs
    var tabs = $('#tabs > ul');
    $('a', tabs).click(function() {
        // disable previous active button
        $('li', tabs).removeClass('active');
        
        // Highlight selected button
        $(this).parent().addClass('active');
        
        switch ($(this).parent().index()) {
            case 0: // initial setup
                $('#content').load("./tabs/initial_setup.html");
            break;
            case 1: // pid tuning
                $('#content').load("./tabs/pid_tuning.html");
            break;            
            case 2: // sensor data
                $('#content').load("./tabs/sensor_data.html");
            break;
        }
    });
 
    // Load initial tab to content div
    $('li > a:first', tabs).click(); 
    
    // Specific functions in content
    $('#content').delegate('.calibrateESC', 'click', function() {  
        chrome.serial.write(connectionId, str2ab("[2:0]"), function(writeInfo) {
            if (writeInfo.bytesWritten > 0) {
                console.log("Wrote: " + writeInfo.bytesWritten + " bytes");
                
                var d = new Date();
                var time = d.getHours() + ':' + d.getMinutes() + ':' + ((d.getSeconds() < 10) ? '0' + d.getSeconds(): d.getSeconds());
                
                $('div#command-log > div.wrapper').append('<p>' + time + ' -- ESC Calibration at next start of FC/UAV requested ... <span style="color: green;">ACK</span></p>');
                $('div#command-log').scrollTop($('div#command-log div.wrapper').height());
            }    
        });
    });
});


function onOpen(openInfo) {
    connectionId = openInfo.connectionId;
    
    if (connectionId != -1) {
        console.log('Connection was opened with ID: ' + connectionId);
        
        // Start reading
        chrome.serial.read(connectionId, 1, onCharRead);
        
        // request configuration data (so we have something to work with)
        chrome.serial.write(connectionId, str2ab("[1:0]"), function(writeInfo) {
            console.log("Wrote: " + writeInfo.bytesWritten + " bytes");
        });  
    } else {
        console.log('There was a problem in opening the connection.');
    }    
};

function onClosed(result) {
    if (result) { // All went as expected
        console.log('Connection closed successfully.');
    } else { // Something went wrong
        console.log('There was an error that happened during "connection-close" procedure.');
    }    
};

function readPoll() {
    chrome.serial.read(connectionId, 24, onCharRead);
};


var packet_state = 0;
var command_buffer = new Array();
var command_i = 0;
var command;

var message_buffer = new Array();
var chars_read = 0;
function onCharRead(readInfo) {
    if (readInfo && readInfo.bytesRead > 0 && readInfo.data) {
        var data = new Uint8Array(readInfo.data);
        
        for (var i = 0; i < data.length; i++) {
            switch (packet_state) {
                case 0:
                    if (data[i] == 91) { // [
                        // Reset variables
                        command_buffer.length = 0; // empty array
                        message_buffer.length = 0; // empty array
                        
                        command_i = 0;
                        chars_read = 0;
                        
                        packet_state++;
                    }
                break;
                case 1:
                    if (data[i] != 58) { // :
                        command_buffer = data[i];
                        command_i++;
                    } else {    
                        packet_state++;
                    }    
                break;
                case 2:
                    if (data[i] != 93) { // ]
                        message_buffer[chars_read] = data[i];
                        chars_read++;
                    } else { // Ending char received, process data
                        command = String.fromCharCode(command_buffer);
                        process_data();
                        
                        packet_state = 0;
                    }                    
                break;
            }
        }
    }
};

function process_data() {
    switch (command) {
        case '1': // configuration data // 1
            var eepromConfigBytes = new ArrayBuffer(264);
            var eepromConfigBytesView = new Uint8Array(eepromConfigBytes);
            for (var i = 0; i < message_buffer.length; i++) {
                eepromConfigBytesView[i] = message_buffer[i];
            }
            
            var view = new jDataView(eepromConfigBytes, 0, undefined, true);
   
            var parser = new jParser(view, {
                eepromConfigDefinition: {
                    version: 'uint8',
                    calibrateESC: 'uint8',

                    ACCEL_BIAS: ['array', 'int16', 3],

                    PID_YAW_c: ['array', 'float64', 4],
                    PID_PITCH_c: ['array', 'float64', 4],
                    PID_ROLL_c: ['array', 'float64', 4],

                    PID_YAW_m: ['array', 'float64', 4],
                    PID_PITCH_m: ['array', 'float64', 4],
                    PID_ROLL_m: ['array', 'float64', 4],

                    PID_BARO: ['array', 'float64', 4],
                    PID_SONAR: ['array', 'float64', 4]
                }
            });

            eepromConfig = parser.parse('eepromConfigDefinition');
            
            console.log(eepromConfig);
        break;
        case 50: // 2
        break;
        case '9': // ACK // 9
            var message = String.fromCharCode(message_buffer);
            
            if (message == '1') {
                console.log("ACK");
            } else {
                console.log("REFUSED");
            }
        break;
    }
}


// String to array buffer
function str2ab(str) {
    var buf = new ArrayBuffer(str.length);
    var bufView = new Uint8Array(buf);
    
    for (var i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    
    return buf;
};